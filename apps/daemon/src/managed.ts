import { ProjectManager, ProjectOrchestrator, type ProjectCatalog } from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  reportDiagnostics,
  type DiagnosticSink,
} from "@stackyard/diagnostics";

import { createDashboardWebHandler } from "./dashboard-web.ts";
import { resolveStackyardDirectories } from "./directories.ts";
import { acquireDaemonLock, publishLocator, removeLocator, type DaemonLocator } from "./locator.ts";
import { BunPortAllocator } from "./ports.ts";
import { BunProcessHost } from "./processes.ts";
import { openProjectCatalog } from "./projects.ts";
import { closeControlServer, startControlServer, type ControlData } from "./server.ts";

export interface ManagedDaemonOptions {
  readonly dashboardWebDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly evaluatorEntrypoint: string;
  readonly dataDirectory?: string;
  readonly onStarted?: (locator: DaemonLocator) => void;
  readonly runtimeDirectory?: string;
}

export async function runManagedDaemon(options: ManagedDaemonOptions): Promise<number> {
  const directories = resolveStackyardDirectories({
    ...(options.dataDirectory ? { dataOverride: options.dataDirectory } : {}),
    ...(options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {}),
  });
  const directory = directories.runtime;
  const instanceId = crypto.randomUUID();
  const lockResult = await acquireDaemonLock(directory, instanceId);
  if (!lockResult.success) {
    reportDiagnostics(options.diagnostics, lockResult.diagnostics);
    return 1;
  }
  if (!lockResult.output) {
    return 0;
  }

  const lock = lockResult.output;
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const manager = createProjectManager(options.diagnostics);
  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  let shuttingDown = false;
  let locatorPublished = false;
  let catalog: ProjectCatalog | undefined;
  let server: Bun.Server<ControlData> | undefined;
  let exitCode = 0;
  const { promise: shutdown, resolve: finish } = Promise.withResolvers<void>();
  const requestShutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Let an HTTP shutdown request return its response before server teardown begins.
    setTimeout(finish);
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    const openedCatalog = await openProjectCatalog({
      dataDirectory: directories.data,
      diagnostics: options.diagnostics,
      evaluatorEntrypoint: options.evaluatorEntrypoint,
    });
    if (!openedCatalog.success) {
      reportDiagnostics(options.diagnostics, openedCatalog.diagnostics);
      return 1;
    }
    catalog = openedCatalog.output;
    const projects = new ProjectOrchestrator(catalog, manager);

    const started = startControlServer({
      diagnostics: options.diagnostics,
      handleUnhandledRequest: createDashboardWebHandler(options.dashboardWebDirectory),
      instanceId,
      isShuttingDown: () => shuttingDown,
      manager,
      onClose(socket) {
        sockets.delete(socket);
      },
      onOpen(socket) {
        sockets.add(socket);
      },
      port: 0,
      projects,
      requestShutdown,
      token,
    });
    if (!started.success) {
      reportDiagnostics(options.diagnostics, started.diagnostics);
      return 1;
    }

    server = started.output;
    if (server.port === undefined) {
      options.diagnostics.report(
        createDiagnostic({
          code: "SYD3001",
          help: "Restart Stackyard, then retry.",
          message: "The daemon did not expose its allocated port.",
        }),
      );
      return 1;
    }

    const locator = await publishLocator(directory, {
      instanceId,
      pid: process.pid,
      port: server.port,
      token,
    });
    locatorPublished = true;
    options.onStarted?.(locator);
    await shutdown;
  } catch (error) {
    options.diagnostics.report(
      lifecycleDiagnostic("The Stackyard daemon stopped unexpectedly.", error),
    );
    exitCode = 1;
  } finally {
    shuttingDown = true;
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);

    await closeControlServer(manager, sockets, options.diagnostics);
    if (server) {
      try {
        await server.stop(true);
      } catch (error) {
        options.diagnostics.report(lifecycleDiagnostic("The daemon server could not stop.", error));
        exitCode = 1;
      }
    }
    await catalog?.close();
    if (locatorPublished) {
      try {
        await removeLocator(directory, instanceId);
      } catch (error) {
        options.diagnostics.report(
          lifecycleDiagnostic("The daemon locator could not be removed.", error),
        );
        exitCode = 1;
      }
    }
    try {
      await lock.release();
    } catch (error) {
      options.diagnostics.report(
        lifecycleDiagnostic("The daemon lock could not be released.", error),
      );
      exitCode = 1;
    }
  }
  return exitCode;
}

export interface ForegroundDaemonOptions {
  readonly diagnostics: DiagnosticSink;
  readonly onStarted?: (url: string) => void;
  readonly port: number;
}

export async function runForegroundDaemon(options: ForegroundDaemonOptions): Promise<number> {
  const manager = createProjectManager(options.diagnostics);
  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  let shuttingDown = false;
  const started = startControlServer({
    diagnostics: options.diagnostics,
    instanceId: crypto.randomUUID(),
    isShuttingDown: () => shuttingDown,
    manager,
    onClose(socket) {
      sockets.delete(socket);
    },
    onOpen(socket) {
      sockets.add(socket);
    },
    port: options.port,
    token: `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
  });
  if (!started.success) {
    reportDiagnostics(options.diagnostics, started.diagnostics);
    return 1;
  }

  const server = started.output;
  let exitCode = 0;
  const { promise: shutdown, resolve: finish } = Promise.withResolvers<void>();
  try {
    if (options.onStarted) {
      options.onStarted(server.url.href);
    }
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    await shutdown;
  } catch (error) {
    options.diagnostics.report(
      lifecycleDiagnostic("The Stackyard daemon stopped unexpectedly.", error),
    );
    exitCode = 1;
  } finally {
    shuttingDown = true;
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    await closeControlServer(manager, sockets, options.diagnostics);
    try {
      await server.stop(true);
    } catch (error) {
      options.diagnostics.report(lifecycleDiagnostic("The daemon server could not stop.", error));
      exitCode = 1;
    }
  }
  return exitCode;
}

function createProjectManager(diagnostics: DiagnosticSink): ProjectManager {
  return new ProjectManager({
    ports: new BunPortAllocator(),
    processes: new BunProcessHost(diagnostics),
  });
}

function lifecycleDiagnostic(message: string, error: unknown) {
  return createDiagnostic({
    code: "SYD3011",
    help: "Restart Stackyard. If the problem persists, inspect the runtime directory and managed processes.",
    message,
    notes: [describeError(error)],
  });
}
