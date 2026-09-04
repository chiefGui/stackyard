import { join, resolve } from "node:path";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Context, Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { createServer, type ViteDevServer } from "vite";

import { Daemon, makeDaemonLayer } from "../apps/daemon/src/daemon.ts";
import { publishLocator } from "../apps/daemon/src/locator.ts";
import {
  describeError,
  formatDiagnostic,
  isNonEmptyDiagnostics,
  reportDiagnostics,
  type DiagnosticSink,
} from "../packages/diagnostics/src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = join(repositoryRoot, "apps", "cli", "src", "main.ts");
const diagnostics: DiagnosticSink = {
  report(diagnostic) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  },
};

BunRuntime.runMain(
  runDevelopment().pipe(
    Effect.provide(BunServices.layer),
    Effect.tap((exitCode) =>
      Effect.sync(() => {
        process.exitCode = exitCode;
      }),
    ),
    Effect.asVoid,
  ),
);

function runDevelopment(): Effect.Effect<
  number,
  never,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
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
    const dataDirectory = yield* Effect.acquireRelease(
      fileSystem.makeTempDirectory({ prefix: "stackyard-development-" }),
      (directory) =>
        fileSystem
          .remove(directory, { force: true, recursive: true })
          .pipe(
            Effect.catch((error) =>
              reportCleanupFailure("Development state cleanup failed", error),
            ),
          ),
    );
    const instanceId = yield* crypto.randomUUIDv4;
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
      yield* publishLocator(dataDirectory, {
        instanceId: daemon.instanceId,
        pid: process.pid,
        port: daemon.port,
        token: daemon.token,
      });
      yield* Effect.acquireRelease(
        startDevelopmentProject(projectPath, dataDirectory),
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
    yield* Effect.acquireRelease(startDashboard(dashboardPort), (server) =>
      Effect.tryPromise({ try: () => server.close(), catch: (error) => error }).pipe(
        Effect.catch((error) => reportCleanupFailure("Dashboard cleanup failed", error)),
      ),
    );

    process.stdout.write(`API:       ${daemon.url}\n`);
    process.stdout.write(`Dashboard: http://127.0.0.1:${dashboardPort}/\n`);
    yield* daemon.awaitShutdown;
  }).pipe(
    Effect.scoped,
    Effect.match({
      onFailure: (error) => {
        if (typeof error === "object" && error !== null) {
          const failureDiagnostics = Reflect.get(error, "diagnostics");
          if (isNonEmptyDiagnostics(failureDiagnostics)) {
            reportDiagnostics(diagnostics, failureDiagnostics);
            return 1;
          }
        }
        process.stderr.write(`Development environment failed: ${describeError(error)}\n`);
        return 1;
      },
      onSuccess: () => (cleanupFailed ? 1 : 0),
    }),
  );
}

const startDashboard = Effect.fn("startDevelopmentDashboard")(function* (
  port: number,
): Effect.fn.Return<ViteDevServer, unknown> {
  const dashboard = yield* Effect.tryPromise({
    try: () =>
      createServer({
        clearScreen: false,
        configFile: join(repositoryRoot, "apps", "dashboard-web", "vite.config.ts"),
        root: join(repositoryRoot, "apps", "dashboard-web"),
        server: { host: "127.0.0.1", port, strictPort: true },
      }),
    catch: (error) => error,
  });
  yield* Effect.tryPromise({ try: () => dashboard.listen(), catch: (error) => error });
  return dashboard;
});

const startDevelopmentProject = Effect.fn("startDevelopmentProject")(function* (
  projectPath: string,
  runtimeDirectory: string,
): Effect.fn.Return<Bun.Subprocess, unknown> {
  const environment = {
    ...stringEnvironment(process.env),
    STACKYARD_RUNTIME_DIR: runtimeDirectory,
  };
  const added = spawnCli(["add", projectPath], environment);
  const exitCode = yield* Effect.tryPromise({ try: () => added.exited, catch: (error) => error });
  if (exitCode !== 0) {
    return yield* Effect.fail(new Error("The development project could not be added."));
  }
  return spawnCli(["run", projectPath], environment);
});

const stopDevelopmentProject = Effect.fn("stopDevelopmentProject")(
  (subprocess: Bun.Subprocess): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          if (subprocess.exitCode === null) {
            subprocess.kill("SIGINT");
          }
        },
        catch: (error) => error,
      });
      yield* Effect.tryPromise({ try: () => subprocess.exited, catch: (error) => error });
    }),
);

function spawnCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Bun.Subprocess {
  return Bun.spawn({
    cmd: [process.execPath, cliEntrypoint, ...args],
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
