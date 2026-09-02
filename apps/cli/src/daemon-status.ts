import { daemonUrl, type DaemonLocator } from "@stackyard/daemon/locator";
import { reportDiagnostics, type DiagnosticSink, type Result } from "@stackyard/diagnostics";

import { defineCliCommand, type CliCommand } from "./cli.ts";

export interface DaemonStatusCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  find(): Promise<Result<DaemonLocator | undefined>>;
  writeOutput(output: string): void;
}

export function createDaemonStatusCommand(
  dependencies: DaemonStatusCommandDependencies,
): CliCommand {
  return defineCliCommand(
    "status",
    "SYD2018",
    {
      meta: { description: "Show whether the Stackyard daemon is running" },
      async run() {
        const found = await dependencies.find();
        if (!found.success) {
          reportDiagnostics(dependencies.diagnostics, found.diagnostics);
          return 1;
        }
        if (!found.output) {
          dependencies.writeOutput("Stackyard is not running.\n");
          return 0;
        }
        dependencies.writeOutput(
          `Stackyard is running at ${daemonUrl(found.output)}\nPID: ${found.output.pid}\n`,
        );
        return 0;
      },
    },
    "daemon status",
  );
}
