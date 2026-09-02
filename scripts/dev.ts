import { join, resolve } from "node:path";

import { createServer, type ViteDevServer } from "vite";

import { startDaemon, type RunningDaemon } from "../apps/daemon/src/daemon.ts";
import {
  describeError,
  formatDiagnostic,
  reportDiagnostics,
} from "../packages/diagnostics/src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const diagnostics = {
  report(diagnostic: Parameters<typeof formatDiagnostic>[0]) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  },
};

const developmentExitCode = await runDevelopmentEnvironment();
if (developmentExitCode !== 0) {
  process.exit(developmentExitCode);
}

async function runDevelopmentEnvironment(): Promise<number> {
  const { promise: shutdownSignaled, resolve: finishShutdownSignal } =
    Promise.withResolvers<void>();
  const requestShutdown = (): void => finishShutdownSignal();
  let daemon: RunningDaemon | undefined;
  let dashboard: ViteDevServer | undefined;
  let exitCode = 0;
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    const apiPort = readDevelopmentPort("STACKYARD_API_PORT", 3000);
    const dashboardPort = readDevelopmentPort("STACKYARD_DASHBOARD_PORT", 5173);
    const started = await startDaemon({
      dataDirectory: join(repositoryRoot, ".stackyard", "development"),
      diagnostics,
      evaluatorEntrypoint: join(repositoryRoot, "apps", "cli", "src", "main.ts"),
      instanceId: crypto.randomUUID(),
      port: apiPort,
    });
    if (!started.success) {
      reportDiagnostics(diagnostics, started.diagnostics);
      return 1;
    }
    daemon = started.output;

    await registerRepository(daemon);
    process.env.STACKYARD_CONTROL_URL = daemon.url.href;
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

    process.stdout.write(`API:       ${daemon.url.href}\n`);
    process.stdout.write(`Dashboard: http://127.0.0.1:${dashboardPort}/\n`);
    await Promise.race([shutdownSignaled, daemon.shutdownRequested]);
  } catch (error) {
    process.stderr.write(`Development environment failed: ${describeError(error)}\n`);
    exitCode = 1;
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    if (dashboard) {
      try {
        await dashboard.close();
      } catch (error) {
        process.stderr.write(`Dashboard cleanup failed: ${describeError(error)}\n`);
        exitCode = 1;
      }
    }
    if (daemon) {
      const closed = await daemon.close();
      if (!closed.success) {
        reportDiagnostics(diagnostics, closed.diagnostics);
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

async function registerRepository(daemon: RunningDaemon): Promise<void> {
  const response = await fetch(new URL("api/v1/projects", daemon.url), {
    body: JSON.stringify({ path: repositoryRoot }),
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`The development project could not be registered (HTTP ${response.status}).`);
  }
}

function readDevelopmentPort(name: string, fallback: number): number {
  const input = process.env[name];
  const port = input === undefined ? fallback : Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a whole number from 1 to 65535.`);
  }
  return port;
}
