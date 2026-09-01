import { ProjectManager, type ProjectRegistry } from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  reportDiagnostics,
  type DiagnosticSink,
} from "@stackyard/diagnostics";

import { createDashboardWebHandler } from "./dashboard-web.ts";
import { resolveStackyardDirectories } from "./directories.ts";
import { acquireDaemonLock, publishLocator, removeLocator } from "./locator.ts";
import { BunPortAllocator } from "./ports.ts";
import { BunProcessHost } from "./processes.ts";
import { openProjectRegistry } from "./project-registrations.ts";
import { closeControlServer, startControlServer, type ControlData } from "./server.ts";

const idleMilliseconds = 15_000;

export interface ManagedDaemonOptions {
  readonly dashboardWebDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly evaluatorEntrypoint: string;
  readonly dataDirectory?: string;
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
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let finish = noop;
  let locatorPublished = false;
  let registry: ProjectRegistry | undefined;
  let server: Bun.Server<ControlData> | undefined;
  let exitCode = 0;

  try {
    const openedRegistry = await openProjectRegistry({
      dataDirectory: directories.data,
      diagnostics: options.diagnostics,
      evaluatorEntrypoint: options.evaluatorEntrypoint,
      isActive: (root) => manager.isActive(root),
    });
    if (!openedRegistry.success) {
      reportDiagnostics(options.diagnostics, openedRegistry.diagnostics);
      return 1;
    }
    registry = openedRegistry.output;

    const started = startControlServer({
      diagnostics: options.diagnostics,
      handleUnhandledRequest: createDashboardWebHandler(options.dashboardWebDirectory),
      instanceId,
      isShuttingDown: () => shuttingDown,
      manager,
      onClose(socket) {
        sockets.delete(socket);
        scheduleIdleShutdown();
      },
      onActivity() {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        scheduleIdleShutdown();
      },
      onOpen(socket) {
        sockets.add(socket);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      },
      port: 0,
      registrations: registry,
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

    await publishLocator(directory, {
      instanceId,
      pid: process.pid,
      port: server.port,
      token,
    });
    locatorPublished = true;

    const shutdown = new Promise<void>((finishShutdown) => {
      finish = finishShutdown;
    });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    scheduleIdleShutdown();
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
    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    await closeControlServer(manager, sockets, options.diagnostics);
    if (server) {
      try {
        await server.stop(true);
      } catch (error) {
        options.diagnostics.report(lifecycleDiagnostic("The daemon server could not stop.", error));
        exitCode = 1;
      }
    }
    await registry?.close();
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

  function scheduleIdleShutdown(): void {
    if (sockets.size > 0 || manager.listProjects().projects.length > 0 || idleTimer) {
      return;
    }
    idleTimer = setTimeout(finish, idleMilliseconds);
  }
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
    onActivity: noop,
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
  let finish = noop;
  let exitCode = 0;
  try {
    if (options.onStarted) {
      options.onStarted(server.url.href);
    }
    const shutdown = new Promise<void>((resolveShutdown) => {
      finish = resolveShutdown;
    });
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
    createId: () => crypto.randomUUID(),
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

function noop(): void {}
