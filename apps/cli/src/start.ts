import { daemonUrl, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  reportDiagnostics,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";

import { defineCliCommand, type CliCommand } from "./cli.ts";

export interface StartCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  find(): Promise<Result<DaemonLocator | undefined>>;
  runForeground(onStarted: (locator: DaemonLocator) => void): Promise<number>;
  start(): Promise<Result<DaemonLocator>>;
  writeOutput(output: string): void;
}

export function createStartCommand(dependencies: StartCommandDependencies): CliCommand {
  return defineCliCommand(
    "start",
    "SYD2016",
    {
      args: {
        foreground: {
          description: "Keep Stackyard attached to this terminal",
          type: "boolean",
        },
      },
      meta: { description: "Start the Stackyard daemon" },
      run({ args }) {
        return args.foreground ? startForeground(dependencies) : startDetached(dependencies);
      },
    },
    "daemon start",
  );
}

async function startForeground(dependencies: StartCommandDependencies): Promise<number> {
  const active = await dependencies.find();
  if (!active.success) {
    reportDiagnostics(dependencies.diagnostics, active.diagnostics);
    return 1;
  }
  if (active.output) {
    dependencies.diagnostics.report(
      createDiagnostic({
        code: "SYD2016",
        help: "Run 'stackyard daemon stop', then start Stackyard in the foreground.",
        message: "Stackyard is already running.",
        notes: [`Dashboard: ${daemonUrl(active.output)}`],
      }),
    );
    return 1;
  }

  let announced = false;
  const exitCode = await dependencies.runForeground((locator) => {
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
}

async function startDetached(dependencies: StartCommandDependencies): Promise<number> {
  const started = await dependencies.start();
  if (!started.success) {
    reportDiagnostics(dependencies.diagnostics, started.diagnostics);
    return 1;
  }
  writeStarted(started.output, false, dependencies);
  return 0;
}

function writeStarted(
  locator: DaemonLocator,
  foreground: boolean,
  dependencies: StartCommandDependencies,
): void {
  dependencies.writeOutput(`Stackyard is running at ${daemonUrl(locator)}\n`);
  if (foreground) {
    dependencies.writeOutput("Press Ctrl+C to stop.\n");
  }
}
