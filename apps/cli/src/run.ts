import { daemonUrl, ensureDaemon, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  reportDiagnostics,
  type Diagnostic,
  type DiagnosticSink,
} from "@stackyard/diagnostics";
import type { ProjectLoadOutcome } from "@stackyard/project-loader";
import {
  createStartProjectMessage,
  createStopProjectMessage,
  parseDaemonServerMessage,
  type ProjectSpec,
} from "@stackyard/protocol";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import { writeProjectEvaluationOutput } from "./project-output.ts";

export interface RunCommandDependencies {
  readonly daemonEntrypoint: string;
  readonly dashboardWebDirectory: string;
  readonly diagnostics: DiagnosticSink;
  loadProject(path: string | undefined): Promise<ProjectLoadOutcome>;
  writeError(output: string): void;
  writeOutput(output: string): void;
}

export function createRunCommand(dependencies: RunCommandDependencies): CliCommand {
  return defineCliCommand(
    "run",
    {
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
        return runProject(args.path, dependencies);
      },
    },
    {
      code: "SYD2009",
      help: "Use: stackyard run [path]",
      tooManyPositionals: "Run accepts at most one project path.",
    },
  );
}

async function runProject(
  path: string | undefined,
  dependencies: RunCommandDependencies,
): Promise<number> {
  const project = await dependencies.loadProject(path);
  writeProjectEvaluationOutput(project, dependencies);
  if (!project.result.success) {
    reportDiagnostics(dependencies.diagnostics, project.result.diagnostics);
    return 1;
  }

  const daemon = await ensureDaemon({
    daemonEntrypoint: dependencies.daemonEntrypoint,
    dashboardWebDirectory: dependencies.dashboardWebDirectory,
  });
  if (!daemon.success) {
    reportDiagnostics(dependencies.diagnostics, daemon.diagnostics);
    return 1;
  }

  return runSession(
    daemon.output,
    project.result.output.location.root,
    project.result.output.spec,
    dependencies,
  );
}

function runSession(
  locator: DaemonLocator,
  root: string,
  spec: ProjectSpec,
  dependencies: RunCommandDependencies,
): Promise<number> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      const controlUrl = new URL("api/v1/control", daemonUrl(locator));
      controlUrl.protocol = "ws:";
      socket = new WebSocket(controlUrl, {
        headers: { authorization: `Bearer ${locator.token}` },
      });
    } catch {
      dependencies.diagnostics.report(connectionDiagnostic("The control connection failed."));
      resolve(1);
      return;
    }
    let settled = false;
    let started = false;
    let stopRequested = false;
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
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      resolve(exitCode);
    };
    const stop = (): void => {
      stopRequested = true;
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.CONNECTING) {
        finish(0);
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(createStopProjectMessage()));
      }
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    socket.addEventListener("open", () => {
      if (stopRequested) {
        finish(0);
        return;
      }
      socket.send(
        JSON.stringify(createStartProjectMessage(root, spec, serviceEnvironment(process.env))),
      );
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
        dependencies.writeOutput(`${spec.name} is running. Dashboard: ${daemonUrl(locator)}\n`);
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
  });
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
