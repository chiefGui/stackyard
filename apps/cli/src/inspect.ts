import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import {
  ProjectEvaluator,
  type LoadedProject,
  type ProjectLoadFailure,
} from "@stackyard/project-loader";
import { Effect, FileSystem, Option, Path } from "effect";
import { Argument, Flag } from "effect/unstable/cli";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import { writeProjectEvaluationOutput } from "./project-output.ts";

export interface InspectCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  loadProject(
    path: string | undefined,
  ): Effect.Effect<
    LoadedProject,
    ProjectLoadFailure,
    FileSystem.FileSystem | Path.Path | ProjectEvaluator
  >;
  writeError(output: string): void;
  writeOutput(output: string): void;
}

export function createInspectCommand(
  dependencies: InspectCommandDependencies,
): CliCommand<FileSystem.FileSystem | Path.Path | ProjectEvaluator> {
  return defineCliCommand("inspect", "SYD2005", {
    args: {
      path: Argument.string("path").pipe(
        Argument.withDescription("Project directory"),
        Argument.optional,
        Argument.map(Option.getOrUndefined),
      ),
      json: Flag.boolean("json").pipe(
        Flag.withDescription("Print compact JSON"),
        Flag.withDefault(false),
      ),
    },
    meta: {
      description: "Evaluate and print a project definition",
    },
    positionalLimit: 1,
    run({ args }) {
      return runInspect(args.path, args.json ?? false, dependencies);
    },
  });
}

const runInspect = Effect.fn("inspectProject")(function* (
  path: string | undefined,
  json: boolean,
  dependencies: InspectCommandDependencies,
): Effect.fn.Return<number, never, FileSystem.FileSystem | Path.Path | ProjectEvaluator> {
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
