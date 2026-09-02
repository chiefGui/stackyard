import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { createDashboardWebHandler } from "./dashboard-web.ts";
import { createDaemonLifecycleDiagnostic, startDaemon, type RunningDaemon } from "./daemon.ts";
import { resolveStackyardDirectories } from "./directories.ts";
import { acquireDaemonLock, publishLocator, removeLocator, type DaemonLocator } from "./locator.ts";

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
  const { promise: shutdownSignaled, resolve: finishShutdownSignal } =
    Promise.withResolvers<void>();
  const requestShutdown = (): void => finishShutdownSignal();
  let daemon: RunningDaemon | undefined;
  let locatorPublished = false;
  let exitCode = 0;
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    const started = await startDaemon({
      dataDirectory: directories.data,
      diagnostics: options.diagnostics,
      evaluatorEntrypoint: options.evaluatorEntrypoint,
      handleUnhandledRequest: createDashboardWebHandler(options.dashboardWebDirectory),
      instanceId,
      port: 0,
    });
    if (!started.success) {
      reportDiagnostics(options.diagnostics, started.diagnostics);
      return 1;
    }
    daemon = started.output;

    const locator = await publishLocator(directory, {
      instanceId: daemon.instanceId,
      pid: process.pid,
      port: daemon.port,
      token: daemon.token,
    });
    locatorPublished = true;
    options.onStarted?.(locator);
    await Promise.race([shutdownSignaled, daemon.shutdownRequested]);
  } catch (error) {
    options.diagnostics.report(
      createDaemonLifecycleDiagnostic("The Stackyard daemon stopped unexpectedly.", error),
    );
    exitCode = 1;
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);

    if (daemon) {
      const closed = await daemon.close();
      if (!closed.success) {
        reportDiagnostics(options.diagnostics, closed.diagnostics);
        exitCode = 1;
      }
    }
    if (locatorPublished) {
      try {
        await removeLocator(directory, instanceId);
      } catch (error) {
        options.diagnostics.report(
          createDaemonLifecycleDiagnostic("The daemon locator could not be removed.", error),
        );
        exitCode = 1;
      }
    }
    try {
      await lock.release();
    } catch (error) {
      options.diagnostics.report(
        createDaemonLifecycleDiagnostic("The daemon lock could not be released.", error),
      );
      exitCode = 1;
    }
  }
  return exitCode;
}
