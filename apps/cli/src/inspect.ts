import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import {
  ProjectEvaluator,
  type LoadedProject,
  type ProjectLoadFailure,
} from "@stackyard/project-loader";
import { Effect } from "effect";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import { writeProjectEvaluationOutput } from "./project-output.ts";

export interface InspectCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  loadProject(
    path: string | undefined,
  ): Effect.Effect<LoadedProject, ProjectLoadFailure, ProjectEvaluator>;
  writeError(output: string): void;
  writeOutput(output: string): void;
}

export function createInspectCommand(
  dependencies: InspectCommandDependencies,
): CliCommand<ProjectEvaluator> {
  return defineCliCommand("inspect", "SYD2005", {
    args: {
      path: {
        description: "Project directory",
        required: false,
        type: "positional",
      },
      json: {
        description: "Print compact JSON",
        type: "boolean",
      },
    },
    meta: {
      description: "Evaluate and print a project definition",
    },
    run({ args }) {
      return runInspect(args.path, args.json ?? false, dependencies);
    },
  });
}

const runInspect = Effect.fn("inspectProject")(function* (
  path: string | undefined,
  json: boolean,
  dependencies: InspectCommandDependencies,
): Effect.fn.Return<number, never, ProjectEvaluator> {
  const loaded = yield* dependencies.loadProject(path).pipe(
    Effect.match({
      onFailure: (project) => ({ loaded: false as const, project }),
      onSuccess: (project) => ({ loaded: true as const, project }),
    }),
  );
  writeProjectEvaluationOutput(loaded.project, dependencies);
  if (!loaded.loaded) {
    reportDiagnostics(dependencies.diagnostics, loaded.project.diagnostics);
    return 1;
  }

  const indentation = json ? undefined : 2;
  dependencies.writeOutput(`${JSON.stringify(loaded.project.spec, undefined, indentation)}\n`);
  return 0;
});
