import { reportDiagnostics, type DiagnosticSink, type Result } from "@stackyard/diagnostics";
import type { StopDaemonStatus } from "@stackyard/daemon/locator";

import { defineCliCommand, type CliCommand } from "./cli.ts";

export interface DaemonStopCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  stop(): Promise<Result<StopDaemonStatus>>;
  writeOutput(output: string): void;
}

export function createDaemonStopCommand(dependencies: DaemonStopCommandDependencies): CliCommand {
  return defineCliCommand(
    "stop",
    "SYD2017",
    {
      meta: { description: "Stop the Stackyard daemon and running projects" },
      async run() {
        const stopped = await dependencies.stop();
        if (!stopped.success) {
          reportDiagnostics(dependencies.diagnostics, stopped.diagnostics);
          return 1;
        }
        dependencies.writeOutput(
          stopped.output === "stopped" ? "Stackyard stopped.\n" : "Stackyard is not running.\n",
        );
        return 0;
      },
    },
    "daemon stop",
  );
}
