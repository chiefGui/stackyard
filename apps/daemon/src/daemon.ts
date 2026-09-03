import { ProjectManager, ProjectOrchestrator } from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  type Diagnostic,
  type DiagnosticSink,
  type NonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";
import { Context, Effect, Layer, Scope } from "effect";

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

export class Daemon extends Context.Service<
  Daemon,
  {
    readonly instanceId: string;
    readonly port: number;
    readonly shutdownRequested: Promise<void>;
    readonly token: string;
    readonly url: string;
  }
>()("stackyard/apps/daemon/Daemon") {}

export type RunningDaemon = Daemon["Service"];

export function makeDaemonLayer(
  options: DaemonOptions,
  reportCleanupFailure: (diagnostic: Diagnostic) => void,
): Layer.Layer<Daemon, NonEmptyDiagnostics> {
  return Layer.effect(Daemon, acquireDaemon(options, reportCleanupFailure));
}

const acquireDaemon = Effect.fn("acquireDaemon")(function* (
  options: DaemonOptions,
  reportCleanupFailure: (diagnostic: Diagnostic) => void,
): Effect.fn.Return<RunningDaemon, NonEmptyDiagnostics, Scope.Scope> {
  const catalog = yield* Effect.acquireRelease(
    acquireResult(
      () =>
        openProjectCatalog({
          dataDirectory: options.dataDirectory,
          diagnostics: options.diagnostics,
          evaluatorEntrypoint: options.evaluatorEntrypoint,
        }),
      "The project catalog could not open.",
    ),
    (openedCatalog) =>
      releaseDaemonResource(
        () => openedCatalog.close(),
        "The project catalog could not close.",
        reportCleanupFailure,
      ),
  );

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
    // Let the accepted shutdown response flush before the scoped server finalizer runs.
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
    return yield* Effect.fail(started.diagnostics);
  }

  const server = yield* Effect.acquireRelease(Effect.succeed(started.output), (runningServer) =>
    Effect.gen(function* () {
      shuttingDown = true;
      yield* releaseDaemonResource(
        () => closeControlServer(manager, sockets, options.diagnostics),
        "Managed projects could not stop.",
        reportCleanupFailure,
      );
      yield* releaseDaemonResource(
        () => runningServer.stop(true),
        "The daemon server could not stop.",
        reportCleanupFailure,
      );
    }),
  );
  if (server.port === undefined) {
    return yield* Effect.fail([
      createDiagnostic({
        code: "SYD3001",
        help: "Restart Stackyard, then retry.",
        message: "The daemon did not expose its allocated port.",
      }),
    ] as const);
  }

  return Daemon.of({
    instanceId: options.instanceId,
    port: server.port,
    shutdownRequested,
    token,
    url: server.url.href,
  });
});

const acquireResult = Effect.fn("acquireResult")(function* <T>(
  operation: () => Promise<Result<T>>,
  unexpectedMessage: string,
): Effect.fn.Return<T, NonEmptyDiagnostics> {
  const result = yield* Effect.tryPromise({
    try: operation,
    catch: (error) => lifecycleFailure(unexpectedMessage, error),
  });
  if (!result.success) {
    return yield* Effect.fail(result.diagnostics);
  }
  return result.output;
});

export const releaseDaemonResource = Effect.fn("releaseDaemonResource")(
  (
    operation: () => Promise<unknown>,
    failureMessage: string,
    reportCleanupFailure: (diagnostic: Diagnostic) => void,
  ) =>
    Effect.tryPromise({
      try: operation,
      catch: (error) => createDaemonLifecycleDiagnostic(failureMessage, error),
    }).pipe(
      Effect.catch((diagnostic) =>
        Effect.sync(() => {
          reportCleanupFailure(diagnostic);
        }),
      ),
      Effect.asVoid,
    ),
);

function lifecycleFailure(message: string, error: unknown): NonEmptyDiagnostics {
  return [createDaemonLifecycleDiagnostic(message, error)];
}

export function createDaemonLifecycleDiagnostic(message: string, error: unknown): Diagnostic {
  return createDiagnostic({
    code: "SYD3011",
    help: "Restart Stackyard. If the problem persists, inspect the runtime directory and managed processes.",
    message,
    notes: [describeError(error)],
  });
}
