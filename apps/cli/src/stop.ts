import { reportDiagnostics, type DiagnosticSink, type Result } from "@stackyard/diagnostics";
import type { StopDaemonStatus } from "@stackyard/daemon/locator";

import { defineCliCommand, type CliCommand } from "./cli.ts";

export interface StopCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  stop(): Promise<Result<StopDaemonStatus>>;
  writeOutput(output: string): void;
}

export function createStopCommand(dependencies: StopCommandDependencies): CliCommand {
  return defineCliCommand("stop", "SYD2017", {
    meta: { description: "Stop Stackyard and its managed processes" },
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
  });
}
