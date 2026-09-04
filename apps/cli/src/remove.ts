import type { DiagnosticSink, Failure } from "@stackyard/diagnostics";
import { CanonicalPath } from "@stackyard/project-loader";
import { Effect, Path } from "effect";
import { Argument } from "effect/unstable/cli";

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
): CliCommand<CanonicalPath | Path.Path | ProjectClient> {
  return defineCliCommand("remove", "SYD2014", {
    args: {
      project: Argument.string("project").pipe(
        Argument.withDescription("Project name, identifier, or directory"),
      ),
    },
    meta: { description: "Remove a project from Stackyard" },
    positionalLimit: 1,
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
): Effect.fn.Return<number, Failure, CanonicalPath | Path.Path | ProjectClient> {
  const client = yield* ProjectClient;
  const normalizedTarget = yield* normalizeProjectTarget(target, dependencies.currentDirectory);
  const removed = yield* client.remove(normalizedTarget);

  dependencies.writeOutput(
    `Removed '${removed.name}' from Stackyard.\nProject files were not changed.\n`,
  );
  return 0;
});
