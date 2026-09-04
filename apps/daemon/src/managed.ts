import { failure, reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import { Effect } from "effect";

import { createDashboardWebHandler } from "./dashboard-web.ts";
import {
  createDaemonLifecycleDiagnostic,
  Daemon,
  makeDaemonLayer,
  releaseDaemonResource,
  type ReportCleanupFailure,
} from "./daemon.ts";
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

export const runManagedDaemon = Effect.fn("runManagedDaemon")(function* (
  options: ManagedDaemonOptions,
): Effect.fn.Return<number> {
  let cleanupFailed = false;
  const reportCleanupFailure: ReportCleanupFailure = (diagnostic) =>
    Effect.sync(() => {
      cleanupFailed = true;
      options.diagnostics.report(diagnostic);
    });

  return yield* manageDaemon(options, reportCleanupFailure).pipe(
    Effect.scoped,
    Effect.matchEffect({
      onFailure: (failed) =>
        Effect.sync(() => {
          reportDiagnostics(options.diagnostics, failed.diagnostics);
          return 1;
        }),
      onSuccess: () => Effect.succeed(cleanupFailed ? 1 : 0),
    }),
  );
});

const manageDaemon = Effect.fn("manageDaemon")(function* (
  options: ManagedDaemonOptions,
  reportCleanupFailure: ReportCleanupFailure,
) {
  const directories = resolveStackyardDirectories({
    ...(options.dataDirectory ? { dataOverride: options.dataDirectory } : {}),
    ...(options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {}),
  });
  const instanceId = crypto.randomUUID();
  const acquiredLock = yield* acquireDaemonLock(directories.runtime, instanceId);
  if (!acquiredLock) {
    return yield* Effect.void;
  }

  const lock = yield* Effect.acquireRelease(Effect.succeed(acquiredLock), (daemonLock) =>
    releaseDaemonResource(
      daemonLock.release.pipe(
        Effect.mapError((error) =>
          createDaemonLifecycleDiagnostic("The daemon lock could not be released.", error),
        ),
      ),
      reportCleanupFailure,
    ),
  );
  return yield* useDaemon(options, directories.runtime, lock.instanceId, reportCleanupFailure).pipe(
    Effect.provide(
      makeDaemonLayer(
        {
          dataDirectory: directories.data,
          diagnostics: options.diagnostics,
          evaluatorEntrypoint: options.evaluatorEntrypoint,
          handleUnhandledRequest: createDashboardWebHandler(options.dashboardWebDirectory),
          instanceId: lock.instanceId,
          port: 0,
        },
        reportCleanupFailure,
      ),
    ),
  );
});

const useDaemon = Effect.fn("useDaemon")(function* (
  options: ManagedDaemonOptions,
  runtimeDirectory: string,
  instanceId: string,
  reportCleanupFailure: ReportCleanupFailure,
) {
  const daemon = yield* Daemon;
  const locator = yield* Effect.acquireRelease(
    publishLocator(runtimeDirectory, {
      instanceId: daemon.instanceId,
      pid: process.pid,
      port: daemon.port,
      token: daemon.token,
    }).pipe(
      Effect.mapError((error) =>
        failure(
          createDaemonLifecycleDiagnostic("The daemon locator could not be published.", error),
        ),
      ),
    ),
    () =>
      releaseDaemonResource(
        removeLocator(runtimeDirectory, instanceId).pipe(
          Effect.mapError((error) =>
            createDaemonLifecycleDiagnostic("The daemon locator could not be removed.", error),
          ),
        ),
        reportCleanupFailure,
      ),
  );
  yield* Effect.try({
    try: () => options.onStarted?.(locator),
    catch: (error) =>
      failure(createDaemonLifecycleDiagnostic("The daemon startup callback failed.", error)),
  });
  return yield* daemon.awaitShutdown;
}, Effect.scoped);
