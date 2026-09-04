import type { StopDaemonStatus } from "@stackyard/daemon/locator";
import type { DiagnosticSink, Failure } from "@stackyard/diagnostics";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";

export interface DaemonStopCommandDependencies<R = never> {
  readonly diagnostics: DiagnosticSink;
  stop(): Effect.Effect<StopDaemonStatus, Failure, HttpClient.HttpClient | R>;
  writeOutput(output: string): void;
}

export function createDaemonStopCommand<R>(
  dependencies: DaemonStopCommandDependencies<R>,
): CliCommand<HttpClient.HttpClient | R> {
  return defineCliCommand(
    "stop",
    "SYD2017",
    {
      args: {},
      meta: { description: "Stop the Stackyard daemon and running projects" },
      run() {
        return reportCommandFailure(
          Effect.gen(function* () {
            const stopped = yield* dependencies.stop();
            dependencies.writeOutput(
              stopped === "stopped" ? "Stackyard stopped.\n" : "Stackyard is not running.\n",
            );
            return 0;
          }),
          dependencies.diagnostics,
        );
      },
    },
    "daemon stop",
  );
}
