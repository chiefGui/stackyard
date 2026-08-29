import {
  createDiagnostic,
  reportDiagnostics,
  type Diagnostic,
  type DiagnosticSink,
} from "@stackyard/diagnostics";
import type { CapturedProcessOutput, ProjectLoadOutcome } from "@stackyard/project-loader";

import type { CliCommand } from "./cli.ts";

export interface InspectCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  loadProject(path: string | undefined): Promise<ProjectLoadOutcome>;
  writeError(output: string): void;
  writeOutput(output: string): void;
}

export function createInspectCommand(dependencies: InspectCommandDependencies): CliCommand {
  return {
    description: "Evaluate and print a project definition",
    name: "inspect",
    run(args) {
      return runInspect(args, dependencies);
    },
    usage: "inspect [path] [--json]",
  };
}

interface InspectOptions {
  readonly json: boolean;
  readonly path: string | undefined;
  readonly success: true;
}

interface InvalidInspectOptions {
  readonly diagnostics: readonly Diagnostic[];
  readonly success: false;
}

async function runInspect(
  args: readonly string[],
  dependencies: InspectCommandDependencies,
): Promise<number> {
  const options = parseInspectArguments(args);
  if (!options.success) {
    reportDiagnostics(dependencies.diagnostics, options.diagnostics);
    return 1;
  }

  const project = await dependencies.loadProject(options.path);
  writeProjectOutput(project.stdout, project.stderr, dependencies);

  if (!project.result.success) {
    reportDiagnostics(dependencies.diagnostics, project.result.diagnostics);
    return 1;
  }

  dependencies.writeOutput(
    `${JSON.stringify(project.result.output.spec, undefined, options.json ? undefined : 2)}\n`,
  );
  return 0;
}

function parseInspectArguments(args: readonly string[]): InspectOptions | InvalidInspectOptions {
  let json = false;
  let path: string | undefined;

  for (const argument of args) {
    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument.startsWith("-")) {
      return invalidArguments(`Unknown option '${argument}'.`);
    }

    if (path) {
      return invalidArguments("Inspect accepts at most one project path.");
    }

    path = argument;
  }

  return { json, path, success: true };
}

function invalidArguments(message: string): InvalidInspectOptions {
  return {
    diagnostics: [createDiagnostic("SYD2005", message)],
    success: false,
  };
}

function writeProjectOutput(
  stdout: CapturedProcessOutput,
  stderr: CapturedProcessOutput,
  dependencies: InspectCommandDependencies,
): void {
  writeCapturedOutput(stdout, "stdout", dependencies);
  writeCapturedOutput(stderr, "stderr", dependencies);
}

function writeCapturedOutput(
  output: CapturedProcessOutput,
  name: "stderr" | "stdout",
  dependencies: InspectCommandDependencies,
): void {
  if (output.text.length > 0) {
    dependencies.writeError(output.text);
  }

  if (output.truncated) {
    const separator = output.text.length > 0 && !output.text.endsWith("\n") ? "\n" : "";
    dependencies.writeError(`${separator}[Stackyard truncated project ${name}.]\n`);
  }
}
