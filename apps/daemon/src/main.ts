import { formatDiagnostic, reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { readPort } from "./config.ts";
import { runForegroundDaemon } from "./managed.ts";

const diagnostics: DiagnosticSink = {
  report(diagnostic) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  },
};

const port = readPort(Bun.env.PORT);
if (!port.success) {
  reportDiagnostics(diagnostics, port.diagnostics);
  process.exitCode = 1;
} else {
  process.exitCode = await runForegroundDaemon({
    diagnostics,
    onStarted(url) {
      process.stdout.write(`Stackyard daemon control API listening at ${url}\n`);
    },
    port: port.output,
  });
}
