import type { DiagnosticSink, Failure } from "@stackyard/diagnostics";
import { Effect } from "effect";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";
import { ProjectClient } from "./project-client.ts";
import { normalizeProjectTarget } from "./project-target.ts";

export interface RemoveCommandDependencies {
  readonly currentDirectory: string;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createRemoveCommand(
  dependencies: RemoveCommandDependencies,
): CliCommand<ProjectClient> {
  return defineCliCommand("remove", "SYD2014", {
    args: {
      project: {
        description: "Project name, identifier, or directory",
        required: true,
        type: "positional",
      },
    },
    meta: { description: "Remove a project from Stackyard" },
    run({ args }) {
      return reportCommandFailure(
        removeProject(args.project, dependencies),
        dependencies.diagnostics,
      );
    },
  });
}

const removeProject = Effect.fn("removeProject")(function* (
  target: string,
  dependencies: RemoveCommandDependencies,
): Effect.fn.Return<number, Failure, ProjectClient> {
  const client = yield* ProjectClient;
  const normalizedTarget = yield* normalizeProjectTarget(target, dependencies.currentDirectory);
  const removed = yield* client.remove(normalizedTarget);

  dependencies.writeOutput(
    `Removed '${removed.name}' from Stackyard.\nProject files were not changed.\n`,
  );
  return 0;
});
