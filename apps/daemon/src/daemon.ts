import { ProjectManager, ProjectOrchestrator, type ProjectCatalog } from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type Diagnostic,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";

import { BunPortAllocator } from "./ports.ts";
import { BunProcessHost } from "./processes.ts";
import { openProjectCatalog } from "./projects.ts";
import {
  closeControlServer,
  startControlServer,
  type ControlData,
  type UnhandledRequestHandler,
} from "./server.ts";

export interface DaemonOptions {
  readonly dataDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly evaluatorEntrypoint: string;
  readonly instanceId: string;
  readonly port: number;
  readonly handleUnhandledRequest?: UnhandledRequestHandler;
}

export interface RunningDaemon {
  readonly instanceId: string;
  readonly port: number;
  readonly shutdownRequested: Promise<void>;
  readonly token: string;
  readonly url: string;
  close(): Promise<Result<void>>;
}

export async function startDaemon(options: DaemonOptions): Promise<Result<RunningDaemon>> {
  const openedCatalog = await openProjectCatalog({
    dataDirectory: options.dataDirectory,
    diagnostics: options.diagnostics,
    evaluatorEntrypoint: options.evaluatorEntrypoint,
  });
  if (!openedCatalog.success) {
    return openedCatalog;
  }

  const catalog = openedCatalog.output;
  const manager = new ProjectManager({
    ports: new BunPortAllocator(),
    processes: new BunProcessHost(options.diagnostics),
  });
  const projects = new ProjectOrchestrator(catalog, manager);
  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const { promise: shutdownRequested, resolve: resolveShutdownRequest } =
    Promise.withResolvers<void>();
  let shuttingDown = false;
  const requestShutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Defer teardown long enough for the shutdown response to reach its caller.
    setTimeout(resolveShutdownRequest);
  };
  const started = startControlServer({
    diagnostics: options.diagnostics,
    ...(options.handleUnhandledRequest
      ? { handleUnhandledRequest: options.handleUnhandledRequest }
      : {}),
    instanceId: options.instanceId,
    isShuttingDown: () => shuttingDown,
    manager,
    onClose(socket) {
      sockets.delete(socket);
    },
    onOpen(socket) {
      sockets.add(socket);
    },
    port: options.port,
    projects,
    requestShutdown,
    token,
  });
  if (!started.success) {
    try {
      await catalog.close();
      return started;
    } catch (error) {
      return failure(
        started.diagnostics[0],
        ...started.diagnostics.slice(1),
        createDaemonLifecycleDiagnostic("The project catalog could not close.", error),
      );
    }
  }

  const server = started.output;
  if (server.port === undefined) {
    await server.stop(true);
    await catalog.close();
    return failure(
      createDiagnostic({
        code: "SYD3001",
        help: "Restart Stackyard, then retry.",
        message: "The daemon did not expose its allocated port.",
      }),
    );
  }

  let closing: Promise<Result<void>> | undefined;
  const close = (): Promise<Result<void>> => {
    shuttingDown = true;
    closing ??= closeDaemon(server, manager, catalog, sockets, options.diagnostics);
    return closing;
  };
  return success(
    Object.freeze({
      close,
      instanceId: options.instanceId,
      port: server.port,
      shutdownRequested,
      token,
      url: server.url.href,
    }),
  );
}

async function closeDaemon(
  server: Bun.Server<ControlData>,
  manager: ProjectManager,
  catalog: ProjectCatalog,
  sockets: ReadonlySet<Bun.ServerWebSocket<ControlData>>,
  diagnostics: DiagnosticSink,
): Promise<Result<void>> {
  const failures: Diagnostic[] = [];
  try {
    await closeControlServer(manager, sockets, diagnostics);
  } catch (error) {
    failures.push(createDaemonLifecycleDiagnostic("Managed projects could not stop.", error));
  }
  try {
    await server.stop(true);
  } catch (error) {
    failures.push(createDaemonLifecycleDiagnostic("The daemon server could not stop.", error));
  }
  try {
    await catalog.close();
  } catch (error) {
    failures.push(createDaemonLifecycleDiagnostic("The project catalog could not close.", error));
  }
  const first = failures[0];
  return first ? failure(first, ...failures.slice(1)) : success(undefined);
}

export function createDaemonLifecycleDiagnostic(message: string, error: unknown): Diagnostic {
  return createDiagnostic({
    code: "SYD3011",
    help: "Restart Stackyard. If the problem persists, inspect the runtime directory and managed processes.",
    message,
    notes: [describeError(error)],
  });
}
