import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context, Effect, Exit, Layer, Scope } from "effect";
import { createServer, type ViteDevServer } from "vite";

import { Daemon, makeDaemonLayer, type RunningDaemon } from "../apps/daemon/src/daemon.ts";
import { publishLocator } from "../apps/daemon/src/locator.ts";
import {
  describeError,
  formatDiagnostic,
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

process.exit(await runDevelopment());

async function runDevelopment(): Promise<number> {
  const { promise: shutdownSignaled, resolve: finishShutdownSignal } =
    Promise.withResolvers<void>();
  const requestShutdown = (): void => finishShutdownSignal();
  let daemon: RunningDaemon | undefined;
  let daemonScope: Scope.Closeable | undefined;
  let dashboard: ViteDevServer | undefined;
  let dataDirectory: string | undefined;
  let projectProcess: Bun.Subprocess | undefined;
  let exitCode = 0;
  let daemonCleanupFailed = false;
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    const projectPath = readProjectPath();
    const apiPort = readPort("STACKYARD_API_PORT", 3000);
    const dashboardPort = readPort("STACKYARD_DASHBOARD_PORT", 5173);
    dataDirectory = await mkdtemp(join(tmpdir(), "stackyard-development-"));
    daemonScope = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(
      Layer.buildWithScope(
        makeDaemonLayer(
          {
            dataDirectory,
            diagnostics,
            evaluatorEntrypoint: cliEntrypoint,
            instanceId: crypto.randomUUID(),
            port: apiPort,
          },
          (diagnostic) => {
            daemonCleanupFailed = true;
            diagnostics.report(diagnostic);
          },
        ),
        daemonScope,
      ).pipe(
        Effect.match({
          onFailure: (failureDiagnostics) => ({
            diagnostics: failureDiagnostics,
            success: false as const,
          }),
          onSuccess: (context) => ({ context, success: true as const }),
        }),
      ),
    );
    if (!started.success) {
      reportDiagnostics(diagnostics, started.diagnostics);
      return 1;
    }
    daemon = Context.get(started.context, Daemon);

    if (projectPath) {
      await publishLocator(dataDirectory, {
        instanceId: daemon.instanceId,
        pid: process.pid,
        port: daemon.port,
        token: daemon.token,
      });
      projectProcess = await startDevelopmentProject(projectPath, dataDirectory);
      process.stdout.write(`Project:   ${projectPath}\n`);
    }
    process.env.STACKYARD_CONTROL_URL = daemon.url;
    dashboard = await createServer({
      clearScreen: false,
      configFile: join(repositoryRoot, "apps", "dashboard-web", "vite.config.ts"),
      root: join(repositoryRoot, "apps", "dashboard-web"),
      server: {
        host: "127.0.0.1",
        port: dashboardPort,
        strictPort: true,
      },
    });
    await dashboard.listen();

    process.stdout.write(`API:       ${daemon.url}\n`);
    process.stdout.write(`Dashboard: http://127.0.0.1:${dashboardPort}/\n`);
    await Promise.race([shutdownSignaled, daemon.shutdownRequested]);
  } catch (error) {
    process.stderr.write(`Development environment failed: ${describeError(error)}\n`);
    exitCode = 1;
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    if (projectProcess) {
      try {
        if (projectProcess.exitCode === null) {
          projectProcess.kill("SIGINT");
        }
        await projectProcess.exited;
      } catch (error) {
        process.stderr.write(`Development project cleanup failed: ${describeError(error)}\n`);
        exitCode = 1;
      }
    }
    if (dashboard) {
      try {
        await dashboard.close();
      } catch (error) {
        process.stderr.write(`Dashboard cleanup failed: ${describeError(error)}\n`);
        exitCode = 1;
      }
    }
    if (daemonScope) {
      await Effect.runPromise(Scope.close(daemonScope, Exit.void));
    }
    if (daemonCleanupFailed) {
      exitCode = 1;
    }
    if (dataDirectory) {
      try {
        await rm(dataDirectory, { force: true, recursive: true });
      } catch (error) {
        process.stderr.write(`Development state cleanup failed: ${describeError(error)}\n`);
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

async function startDevelopmentProject(
  projectPath: string,
  runtimeDirectory: string,
): Promise<Bun.Subprocess> {
  const environment = {
    ...stringEnvironment(process.env),
    STACKYARD_RUNTIME_DIR: runtimeDirectory,
  };
  const added = spawnCli(["add", projectPath], environment);
  if ((await added.exited) !== 0) {
    throw new Error("The development project could not be added.");
  }
  return spawnCli(["run", projectPath], environment);
}

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
