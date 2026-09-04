import { join, resolve } from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schema,
  Scope,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createServer } from "vite";

import { Daemon, makeDaemonLayer } from "../apps/daemon/src/daemon.ts";
import { acquireDaemonLock, publishLocator } from "../apps/daemon/src/locator.ts";
import {
  describeError,
  formatDiagnostic,
  isNonEmptyDiagnostics,
  reportDiagnostics,
  type DiagnosticSink,
} from "../packages/diagnostics/src/index.ts";
import { CanonicalPath, NodeCanonicalPathLayer } from "../packages/project-loader/src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = join(repositoryRoot, "apps", "cli", "src", "main.ts");
const developmentLockDirectory = join(repositoryRoot, ".stackyard", "development-lock");
const developmentStateDirectory = join(repositoryRoot, ".stackyard", "development");
const diagnostics: DiagnosticSink = {
  report(diagnostic) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  },
};

class DevelopmentFailure extends Schema.TaggedError<DevelopmentFailure>()(
  "DevelopmentFailure",
  {},
) {}

BunRuntime.runMain(
  runDevelopment().pipe(Effect.provide(NodeCanonicalPathLayer), Effect.provide(BunServices.layer)),
  { disableErrorReporting: true },
);

function runDevelopment(): Effect.Effect<
  void,
  DevelopmentFailure,
  | CanonicalPath
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
> {
  let cleanupFailed = false;
  const reportCleanupFailure = (message: string, error: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      cleanupFailed = true;
      process.stderr.write(`${message}: ${describeError(error)}\n`);
    });

  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const projectPath = yield* Effect.try({ try: readProjectPath, catch: (error) => error });
    const apiPort = yield* Effect.try({
      try: () => readPort("STACKYARD_API_PORT", 3000),
      catch: (error) => error,
    });
    const dashboardPort = yield* Effect.try({
      try: () => readPort("STACKYARD_DASHBOARD_PORT", 5173),
      catch: (error) => error,
    });
    const instanceId = yield* crypto.randomUUIDv4;
    const acquiredLock = yield* acquireDaemonLock(developmentLockDirectory, instanceId);
    if (!acquiredLock) {
      return yield* Effect.fail(
        new Error("Another Stackyard development environment is already running."),
      );
    }
    yield* Effect.acquireRelease(Effect.succeed(acquiredLock), (lock) =>
      lock.release.pipe(
        Effect.andThen(
          fileSystem.remove(developmentLockDirectory, { force: true, recursive: true }),
        ),
        Effect.catch((error) => reportCleanupFailure("Development lock cleanup failed", error)),
      ),
    );
    const stateDirectory = yield* Effect.acquireRelease(
      fileSystem
        .remove(developmentStateDirectory, { force: true, recursive: true })
        .pipe(
          Effect.andThen(fileSystem.makeDirectory(developmentStateDirectory, { recursive: true })),
          Effect.as(developmentStateDirectory),
        ),
      (directory) =>
        fileSystem
          .remove(directory, { force: true, recursive: true })
          .pipe(
            Effect.catch((error) =>
              reportCleanupFailure("Development state cleanup failed", error),
            ),
          ),
    );
    const dataDirectory = join(stateDirectory, "data");
    const runtimeDirectory = join(stateDirectory, "run");
    const daemonContext = yield* Layer.build(
      makeDaemonLayer(
        {
          dataDirectory,
          diagnostics,
          evaluatorEntrypoint: cliEntrypoint,
          instanceId,
          port: apiPort,
        },
        (diagnostic) =>
          Effect.sync(() => {
            cleanupFailed = true;
            diagnostics.report(diagnostic);
          }),
      ),
    );
    const daemon = Context.get(daemonContext, Daemon);

    if (projectPath) {
      yield* fileSystem.makeDirectory(runtimeDirectory, { recursive: true });
      yield* publishLocator(runtimeDirectory, {
        instanceId: daemon.instanceId,
        pid: process.pid,
        port: daemon.port,
        token: daemon.token,
      });
      yield* Effect.acquireRelease(
        startDevelopmentProject(projectPath, runtimeDirectory),
        (subprocess) =>
          stopDevelopmentProject(subprocess).pipe(
            Effect.catch((error) =>
              reportCleanupFailure("Development project cleanup failed", error),
            ),
          ),
      );
      process.stdout.write(`Project:   ${projectPath}\n`);
    }

    const previousControlUrl = process.env.STACKYARD_CONTROL_URL;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.STACKYARD_CONTROL_URL = daemon.url;
      }),
      () =>
        Effect.sync(() => {
          if (previousControlUrl === undefined) {
            delete process.env.STACKYARD_CONTROL_URL;
          } else {
            process.env.STACKYARD_CONTROL_URL = previousControlUrl;
          }
        }),
    );
    yield* startDashboard(dashboardPort, reportCleanupFailure);

    process.stdout.write(`API:       ${daemon.url}\n`);
    process.stdout.write(`Dashboard: http://127.0.0.1:${dashboardPort}/\n`);
    return yield* daemon.awaitShutdown;
  }).pipe(
    Effect.scoped,
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.sync(() => {
          if (typeof error === "object" && error !== null) {
            const failureDiagnostics = Reflect.get(error, "diagnostics");
            if (isNonEmptyDiagnostics(failureDiagnostics)) {
              reportDiagnostics(diagnostics, failureDiagnostics);
              return;
            }
          }
          process.stderr.write(`Development environment failed: ${describeError(error)}\n`);
        }).pipe(Effect.andThen(Effect.fail(new DevelopmentFailure()))),
      onSuccess: () => (cleanupFailed ? Effect.fail(new DevelopmentFailure()) : Effect.void),
    }),
  );
}

const startDashboard = Effect.fn("startDevelopmentDashboard")(function* (
  port: number,
  reportCleanupFailure: (message: string, error: unknown) => Effect.Effect<void>,
): Effect.fn.Return<void, Error, Scope.Scope> {
  const dashboard = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createServer({
          clearScreen: false,
          configFile: join(repositoryRoot, "apps", "dashboard-web", "vite.config.ts"),
          root: join(repositoryRoot, "apps", "dashboard-web"),
          server: { host: "127.0.0.1", port, strictPort: true },
        }),
      catch: asError,
    }),
    (server) =>
      Effect.tryPromise({ try: () => server.close(), catch: asError }).pipe(
        Effect.catch((error) => reportCleanupFailure("Dashboard cleanup failed", error)),
      ),
  );
  yield* Effect.tryPromise({ try: () => dashboard.listen(), catch: asError });
});

const startDevelopmentProject = Effect.fn("startDevelopmentProject")(function* (
  projectPath: string,
  runtimeDirectory: string,
): Effect.fn.Return<
  ChildProcessSpawner.ChildProcessHandle,
  Error | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = {
    ...stringEnvironment(process.env),
    STACKYARD_RUNTIME_DIR: runtimeDirectory,
  };
  const exitCode = yield* spawner.exitCode(cliCommand(["add", projectPath], environment));
  if (exitCode !== 0) {
    return yield* Effect.fail(new Error("The development project could not be added."));
  }
  return yield* spawner.spawn(cliCommand(["run", projectPath], environment));
});

const stopDevelopmentProject = Effect.fn("stopDevelopmentProject")(
  (
    subprocess: ChildProcessSpawner.ChildProcessHandle,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      if (yield* subprocess.isRunning) {
        yield* subprocess.kill({ killSignal: "SIGINT" });
      }
      yield* subprocess.exitCode;
    }),
);

function cliCommand(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): ChildProcess.Command {
  return ChildProcess.make(process.execPath, [cliEntrypoint, ...args], {
    cwd: repositoryRoot,
    env: environment,
    stderr: "inherit",
    stdin: "ignore",
    stdout: "ignore",
    windowsHide: true,
  });
}

function readProjectPath(): string | undefined {
  const inputs = Bun.argv.slice(2);
  if (inputs.length > 1) {
    throw new Error("Usage: bun dev [project]");
  }
  return inputs[0] ? resolve(repositoryRoot, inputs[0]) : undefined;
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function readPort(name: string, fallback: number): number {
  const input = process.env[name];
  const port = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a whole number from 1 to 65535.`);
  }
  return port;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Platform operation failed.", { cause });
}
