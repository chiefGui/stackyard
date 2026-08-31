import { formatDiagnostic, reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { readPort, startServer, stopServer } from "./server.ts";

const diagnostics: DiagnosticSink = {
  report(diagnostic) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  },
};

process.exitCode = await run();

async function run(): Promise<number> {
  const port = readPort(Bun.env.PORT);
  if (!port.success) {
    reportDiagnostics(diagnostics, port.diagnostics);
    return 1;
  }

  const started = startServer({ diagnostics, port: port.output });
  if (!started.success) {
    reportDiagnostics(diagnostics, started.diagnostics);
    return 1;
  }

  const server = started.output;
  process.stdout.write(`Stackyard daemon listening at ${server.url.href}\n`);
  await waitForShutdown();

  const stopped = await stopServer(server);
  if (!stopped.success) {
    reportDiagnostics(diagnostics, stopped.diagnostics);
    return 1;
  }

  return 0;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };

    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
