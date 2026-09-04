import { reportDiagnostics, type DiagnosticSink, type Failure } from "@stackyard/diagnostics";
import { Effect, Option, Path } from "effect";
import { Argument } from "effect/unstable/cli";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";
import { ProjectClient } from "./project-client.ts";

export interface AddCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  readonly currentDirectory: string;
  writeOutput(output: string): void;
}

export function createAddCommand(
  dependencies: AddCommandDependencies,
): CliCommand<Path.Path | ProjectClient> {
  return defineCliCommand("add", "SYD2013", {
    args: {
      path: Argument.string("path").pipe(
        Argument.withDescription("Project directory (default: current directory)"),
        Argument.optional,
        Argument.map(Option.getOrUndefined),
      ),
    },
    meta: { description: "Add a project to Stackyard" },
    run({ args }) {
      return reportCommandFailure(addProject(args.path, dependencies), dependencies.diagnostics);
    },
  });
}

const addProject = Effect.fn("addProject")(function* (
  path: string | undefined,
  dependencies: AddCommandDependencies,
): Effect.fn.Return<number, Failure, Path.Path | ProjectClient> {
  const paths = yield* Path.Path;
  const client = yield* ProjectClient;
  const project = yield* client.add(paths.resolve(dependencies.currentDirectory, path ?? "."));
  dependencies.writeOutput(`Added '${project.name}' to Stackyard.\nRoot: ${project.root}\n`);
  if (project.issue) {
    dependencies.writeOutput("The project needs attention before it can run.\n");
    reportDiagnostics(dependencies.diagnostics, project.issue.diagnostics);
    return 1;
  }
  return 0;
});
