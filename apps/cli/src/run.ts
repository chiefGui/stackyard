import { realpath } from "node:fs/promises";

import { daemonUrl, ensureDaemon, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  failure,
  reportDiagnostics,
  type Diagnostic,
  type DiagnosticSink,
  type Failure,
} from "@stackyard/diagnostics";
import { discoverProject } from "@stackyard/project-loader";
import {
  createStartProjectMessage,
  createStopProjectMessage,
  parseDaemonServerMessage,
} from "@stackyard/protocol";
import { Effect } from "effect";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";
export interface RunCommandDependencies {
  readonly currentDirectory: string;
  readonly daemonEntrypoint: string;
  readonly dashboardWebDirectory: string;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createRunCommand(dependencies: RunCommandDependencies): CliCommand {
  return defineCliCommand("run", "SYD2009", {
    args: {
      path: {
        description: "Project directory",
        required: false,
        type: "positional",
      },
    },
    meta: {
      description: "Start a project and its dashboard",
    },
    run({ args }) {
      return reportCommandFailure(runProject(args.path, dependencies), dependencies.diagnostics);
    },
  });
}

const runProject = Effect.fn("runProject")(function* (
  path: string | undefined,
  dependencies: RunCommandDependencies,
): Effect.fn.Return<number, Failure> {
  const discovered = yield* discoverProject(path, dependencies.currentDirectory);
  const root = yield* Effect.tryPromise({
    try: () => realpath(discovered.root),
    catch: (error) =>
      failure(
        createDiagnostic({
          code: "SYD2006",
          help: "Verify that the project directory exists and is readable, then retry.",
          message: "The project directory could not be resolved.",
          notes: [error instanceof Error ? error.message : String(error)],
        }),
      ),
  });

  const daemon = yield* ensureDaemon({
    daemonEntrypoint: dependencies.daemonEntrypoint,
    dashboardWebDirectory: dependencies.dashboardWebDirectory,
  });
  return yield* runSession(daemon, root, dependencies);
});

function runSession(
  locator: DaemonLocator,
  root: string,
  dependencies: RunCommandDependencies,
): Effect.Effect<number> {
  return Effect.callback<number>((resume) => {
    let socket: WebSocket;
    try {
      const controlUrl = new URL("api/v1/control", daemonUrl(locator));
      controlUrl.protocol = "ws:";
      socket = new WebSocket(controlUrl, {
        headers: { authorization: `Bearer ${locator.token}` },
      });
    } catch {
      dependencies.diagnostics.report(connectionDiagnostic("The control connection failed."));
      resume(Effect.succeed(1));
      return Effect.void;
    }
    let settled = false;
    let started = false;
    const timeout = setTimeout(() => {
      dependencies.diagnostics.report(
        createDiagnostic({
          code: "SYD2011",
          help: "Check the service commands and Stackyard daemon, then retry.",
          message: "The daemon did not start the project within ten seconds.",
        }),
      );
      finish(1);
    }, 10_000);

    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      closeSocket(socket);
      resume(Effect.succeed(exitCode));
    };

    socket.addEventListener("open", () => {
      if (
        !sendSocketMessage(socket, createStartProjectMessage(root, serviceEnvironment(process.env)))
      ) {
        dependencies.diagnostics.report(
          connectionDiagnostic("The start request could not be sent."),
        );
        finish(1);
      }
    });
    socket.addEventListener("message", (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        dependencies.diagnostics.report(connectionDiagnostic("The daemon sent malformed data."));
        finish(1);
        return;
      }

      const message = parseDaemonServerMessage(value);
      if (!message.success) {
        reportDiagnostics(dependencies.diagnostics, message.diagnostics);
        finish(1);
        return;
      }

      if (message.output.kind === "started") {
        started = true;
        clearTimeout(timeout);
        dependencies.writeOutput(
          `${message.output.projectName} is running. Dashboard: ${daemonUrl(locator)}\n`,
        );
      } else if (message.output.kind === "failed") {
        reportDiagnostics(dependencies.diagnostics, message.output.report.diagnostics);
        finish(1);
      } else if (message.output.kind === "completed") {
        finish(message.output.exitCode);
      } else {
        finish(0);
      }
    });
    socket.addEventListener("error", () => {
      if (!settled) {
        dependencies.diagnostics.report(connectionDiagnostic("The control connection failed."));
        finish(1);
      }
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        let note = "The daemon closed the connection before starting the project.";
        if (started) {
          note = "The daemon connection closed while the project was running.";
        }
        dependencies.diagnostics.report(connectionDiagnostic(note));
        finish(1);
      }
    });
    return Effect.sync(() => {
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) {
        sendSocketMessage(socket, createStopProjectMessage());
      }
      closeSocket(socket);
    });
  });
}

function sendSocketMessage(socket: WebSocket, message: unknown): boolean {
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function closeSocket(socket: WebSocket): void {
  try {
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  } catch {
    // The peer may have closed the socket between the state check and close.
  }
}

function serviceEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !isStackyardVariable(entry[0]),
      ),
    ),
  );
}

function isStackyardVariable(name: string): boolean {
  let comparable = name;
  if (process.platform === "win32") {
    comparable = name.toUpperCase();
  }
  return comparable.startsWith("STACKYARD_");
}

function connectionDiagnostic(note: string): Diagnostic {
  return createDiagnostic({
    code: "SYD2010",
    help: "Run the command again. If the problem persists, stop the stale Stackyard daemon.",
    message: "The Stackyard daemon connection was lost.",
    notes: [note],
  });
}
