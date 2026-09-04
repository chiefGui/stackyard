import { makeProjectManagerLayer, ProjectOrchestratorLayer } from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  type Diagnostic,
  type DiagnosticSink,
  type Failure,
} from "@stackyard/diagnostics";
import { Context, Deferred, Effect, Layer, ManagedRuntime, Scope } from "effect";

import { BunPortAllocatorLayer } from "./ports.ts";
import { makeBunProcessHostLayer } from "./processes.ts";
import { makeProjectCatalogLayer } from "./projects.ts";
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
    readonly awaitShutdown: Effect.Effect<void>;
    readonly instanceId: string;
    readonly port: number;
    readonly token: string;
    readonly url: string;
  }
>()("stackyard/apps/daemon/Daemon") {}

export type RunningDaemon = Daemon["Service"];
export type ReportCleanupFailure = (diagnostic: Diagnostic) => Effect.Effect<void>;

export function makeDaemonLayer(
  options: DaemonOptions,
  reportCleanupFailure: ReportCleanupFailure,
): Layer.Layer<Daemon, Failure> {
  return Layer.effect(Daemon, acquireDaemon(options, reportCleanupFailure));
}

const acquireDaemon = Effect.fn("acquireDaemon")(function* (
  options: DaemonOptions,
  reportCleanupFailure: ReportCleanupFailure,
): Effect.fn.Return<RunningDaemon, Failure, Scope.Scope> {
  const manager = makeProjectManagerLayer({ diagnostics: options.diagnostics }).pipe(
    Layer.provide(Layer.merge(BunPortAllocatorLayer, makeBunProcessHostLayer(options.diagnostics))),
  );
  const catalog = makeProjectCatalogLayer({
    dataDirectory: options.dataDirectory,
    diagnostics: options.diagnostics,
    evaluatorEntrypoint: options.evaluatorEntrypoint,
  });
  const controlPlane = ProjectOrchestratorLayer.pipe(
    Layer.provideMerge(Layer.merge(catalog, manager)),
  );
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(controlPlane)),
    (managed) => managed.disposeEffect,
  );
  yield* runtime.contextEffect;

  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  const token = yield* Effect.sync(() =>
    `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
  );
  const shutdownRequested = yield* Deferred.make<void>();
  let shuttingDown = false;
  const requestShutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    setTimeout(() => Deferred.doneUnsafe(shutdownRequested, Effect.void));
  };

  const server = yield* Effect.acquireRelease(
    startControlServer({
      diagnostics: options.diagnostics,
      ...(options.handleUnhandledRequest
        ? { handleUnhandledRequest: options.handleUnhandledRequest }
        : {}),
      instanceId: options.instanceId,
      isShuttingDown: () => shuttingDown,
      onClose(socket) {
        sockets.delete(socket);
      },
      onOpen(socket) {
        sockets.add(socket);
      },
      port: options.port,
      requestShutdown,
      runtime,
      token,
    }),
    (runningServer) =>
      Effect.gen(function* () {
        shuttingDown = true;
        yield* closeControlServer(runtime, sockets, options.diagnostics);
        yield* releaseDaemonResource(
          Effect.tryPromise({
            try: () => runningServer.stop(true),
            catch: (error) =>
              createDaemonLifecycleDiagnostic("The daemon server could not stop.", error),
          }),
          reportCleanupFailure,
        );
      }),
  );
  if (server.port === undefined) {
    return yield* Effect.fail(
      lifecycleFailure(
        "The daemon did not expose its allocated port.",
        new Error("Bun returned no server port."),
      ),
    );
  }

  return Daemon.of({
    awaitShutdown: Deferred.await(shutdownRequested),
    instanceId: options.instanceId,
    port: server.port,
    token,
    url: server.url.href,
  });
});

export const releaseDaemonResource = Effect.fn("releaseDaemonResource")(
  (
    operation: Effect.Effect<unknown, Diagnostic>,
    reportCleanupFailure: ReportCleanupFailure,
  ): Effect.Effect<void> =>
    operation.pipe(
      Effect.catch((diagnostic) => reportCleanupFailure(diagnostic)),
      Effect.asVoid,
    ),
);

function lifecycleFailure(message: string, error: unknown): Failure {
  return {
    diagnostics: [createDaemonLifecycleDiagnostic(message, error)],
    success: false,
  };
}

export function createDaemonLifecycleDiagnostic(message: string, error: unknown): Diagnostic {
  return createDiagnostic({
    code: "SYD3011",
    help: "Restart Stackyard. If the problem persists, inspect the runtime directory and managed processes.",
    message,
    notes: [describeError(error)],
  });
}
