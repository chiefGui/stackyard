import { daemonUrl, type DaemonLocator } from "@stackyard/daemon/locator";
import { createDiagnostic, type DiagnosticSink, type Failure } from "@stackyard/diagnostics";
import { Effect } from "effect";
import { Flag } from "effect/unstable/cli";
import { HttpClient } from "effect/unstable/http";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";

export interface StartCommandDependencies<R = never> {
  readonly diagnostics: DiagnosticSink;
  find(): Effect.Effect<DaemonLocator | undefined, Failure, HttpClient.HttpClient | R>;
  runForeground(onStarted: (locator: DaemonLocator) => void): Effect.Effect<number, never, R>;
  start(): Effect.Effect<DaemonLocator, Failure, HttpClient.HttpClient | R>;
  writeOutput(output: string): void;
}

export function createStartCommand<R>(
  dependencies: StartCommandDependencies<R>,
): CliCommand<HttpClient.HttpClient | R> {
  return defineCliCommand(
    "start",
    "SYD2016",
    {
      args: {
        foreground: Flag.boolean("foreground").pipe(
          Flag.withDescription("Keep Stackyard attached to this terminal"),
          Flag.withDefault(false),
        ),
      },
      meta: { description: "Start the Stackyard daemon" },
      run({ args }) {
        return reportCommandFailure(
          args.foreground ? startForeground(dependencies) : startDetached(dependencies),
          dependencies.diagnostics,
        );
      },
    },
    "daemon start",
  );
}

const startForeground = Effect.fn("startForeground")(function* <R>(
  dependencies: StartCommandDependencies<R>,
): Effect.fn.Return<number, Failure, HttpClient.HttpClient | R> {
  const active = yield* dependencies.find();
  if (active) {
    dependencies.diagnostics.report(
      createDiagnostic({
        code: "SYD2016",
        help: "Run 'stackyard daemon stop', then start Stackyard in the foreground.",
        message: "Stackyard is already running.",
        notes: [`Dashboard: ${daemonUrl(active)}`],
      }),
    );
    return 1;
  }

  let announced = false;
  const exitCode = yield* dependencies.runForeground((locator) => {
    announced = true;
    writeStarted(locator, true, dependencies);
  });
  if (exitCode !== 0 || announced) {
    return exitCode;
  }

  dependencies.diagnostics.report(
    createDiagnostic({
      code: "SYD2016",
      help: "Use the running Stackyard instance, or stop it before retrying in the foreground.",
      message: "Another Stackyard process started first.",
    }),
  );
  return 1;
});

const startDetached = Effect.fn("startDetached")(function* <R>(
  dependencies: StartCommandDependencies<R>,
): Effect.fn.Return<number, Failure, HttpClient.HttpClient | R> {
  const started = yield* dependencies.start();
  writeStarted(started, false, dependencies);
  return 0;
});

function writeStarted<R>(
  locator: DaemonLocator,
  foreground: boolean,
  dependencies: StartCommandDependencies<R>,
): void {
  dependencies.writeOutput(`Stackyard is running at ${daemonUrl(locator)}\n`);
  if (foreground) {
    dependencies.writeOutput("Press Ctrl+C to stop.\n");
  }
}
