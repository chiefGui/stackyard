import { formatDiagnostic, type Diagnostic, type ProjectSpec } from "@stackyard/protocol";

import { discoverProject } from "./discovery.ts";
import { evaluateProject } from "./evaluation.ts";

export async function runCli(cliEntrypoint: string, args: readonly string[]): Promise<number> {
  const [command, ...commandArgs] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command !== "inspect") {
    printDiagnostics([
      {
        code: "SYD2004",
        message: `Unknown command '${command}'.`,
        path: [],
      },
    ]);
    return 1;
  }

  const options = parseInspectArguments(commandArgs);
  if (!options.success) {
    printDiagnostics(options.diagnostics);
    return 1;
  }

  const location = await discoverProject(options.path);
  if (!location.success) {
    printDiagnostics(location.diagnostics);
    return 1;
  }

  const evaluation = await evaluateProject(
    cliEntrypoint,
    location.output.entrypoint,
    location.output.root,
  );
  writeEvaluationOutput(evaluation.stdout, evaluation.stderr);

  if (!evaluation.result.success) {
    printDiagnostics(evaluation.result.diagnostics);
    return 1;
  }

  printProject(evaluation.result.output, options.json);
  return 0;
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
    diagnostics: [{ code: "SYD2005", message, path: [] }],
    success: false,
  };
}

function printProject(spec: ProjectSpec, compact: boolean): void {
  process.stdout.write(`${JSON.stringify(spec, undefined, compact ? undefined : 2)}\n`);
}

function printDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  }
}

function writeEvaluationOutput(stdout: string, stderr: string): void {
  if (stdout.length > 0) {
    process.stderr.write(stdout);
  }

  if (stderr.length > 0) {
    process.stderr.write(stderr);
  }
}

function printHelp(): void {
  process.stdout.write(
    `Usage: stackyard <command>\n\nCommands:\n  inspect [path] [--json]  Evaluate and print a project definition\n`,
  );
}
