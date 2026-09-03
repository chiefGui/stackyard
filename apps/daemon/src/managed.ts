import { reportDiagnostics, type Diagnostic, type DiagnosticSink } from "@stackyard/diagnostics";
import { Context, Effect, Layer } from "effect";

import { createDashboardWebHandler } from "./dashboard-web.ts";
import {
  createDaemonLifecycleDiagnostic,
  Daemon,
  makeDaemonLayer,
  releaseDaemonResource,
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
  const reportCleanupFailure = (diagnostic: Diagnostic): void => {
    cleanupFailed = true;
    options.diagnostics.report(diagnostic);
  };

  return yield* manageDaemon(options, reportCleanupFailure).pipe(
    Effect.scoped,
    Effect.matchEffect({
      onFailure: (diagnostics) =>
        Effect.sync(() => {
          reportDiagnostics(options.diagnostics, diagnostics);
          return 1;
        }),
      onSuccess: () => Effect.succeed(cleanupFailed ? 1 : 0),
    }),
  );
});

const manageDaemon = Effect.fn("manageDaemon")(function* (
  options: ManagedDaemonOptions,
  reportCleanupFailure: (diagnostic: Diagnostic) => void,
) {
  const directories = resolveStackyardDirectories({
    ...(options.dataDirectory ? { dataOverride: options.dataDirectory } : {}),
    ...(options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {}),
  });
  const instanceId = crypto.randomUUID();
  const lockResult = yield* Effect.tryPromise({
    try: () => acquireDaemonLock(directories.runtime, instanceId),
    catch: (error) =>
      [createDaemonLifecycleDiagnostic("The daemon lock could not be acquired.", error)] as const,
  });
  if (!lockResult.success) {
    return yield* Effect.fail(lockResult.diagnostics);
  }
  if (!lockResult.output) {
    return yield* Effect.void;
  }

  const lock = yield* Effect.acquireRelease(Effect.succeed(lockResult.output), (daemonLock) =>
    releaseDaemonResource(
      () => daemonLock.release(),
      "The daemon lock could not be released.",
      reportCleanupFailure,
    ),
  );
  const daemonContext = yield* Layer.build(
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
  );
  const daemon = Context.get(daemonContext, Daemon);
  const locator = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        publishLocator(directories.runtime, {
          instanceId: daemon.instanceId,
          pid: process.pid,
          port: daemon.port,
          token: daemon.token,
        }),
      catch: (error) =>
        [
          createDaemonLifecycleDiagnostic("The daemon locator could not be published.", error),
        ] as const,
    }),
    () =>
      releaseDaemonResource(
        () => removeLocator(directories.runtime, instanceId),
        "The daemon locator could not be removed.",
        reportCleanupFailure,
      ),
  );
  yield* Effect.try({
    try: () => options.onStarted?.(locator),
    catch: (error) =>
      [createDaemonLifecycleDiagnostic("The daemon startup callback failed.", error)] as const,
  });
  return yield* Effect.promise(() => daemon.shutdownRequested);
});
