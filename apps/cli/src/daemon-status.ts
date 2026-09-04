import { daemonUrl, type DaemonLocator } from "@stackyard/daemon/locator";
import type { DiagnosticSink, Failure } from "@stackyard/diagnostics";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";

export interface DaemonStatusCommandDependencies<R = never> {
  readonly diagnostics: DiagnosticSink;
  find(): Effect.Effect<DaemonLocator | undefined, Failure, HttpClient.HttpClient | R>;
  writeOutput(output: string): void;
}

export function createDaemonStatusCommand<R>(
  dependencies: DaemonStatusCommandDependencies<R>,
): CliCommand<HttpClient.HttpClient | R> {
  return defineCliCommand(
    "status",
    "SYD2018",
    {
      args: {},
      meta: { description: "Show whether the Stackyard daemon is running" },
      run() {
        return reportCommandFailure(
          Effect.gen(function* () {
            const found = yield* dependencies.find();
            if (!found) {
              dependencies.writeOutput("Stackyard is not running.\n");
              return 0;
            }
            dependencies.writeOutput(
              `Stackyard is running at ${daemonUrl(found)}\nPID: ${found.pid}\n`,
            );
            return 0;
          }),
          dependencies.diagnostics,
        );
      },
    },
    "daemon status",
  );
}
