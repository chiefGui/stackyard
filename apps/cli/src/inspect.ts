import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import { type LoadedProject, type ProjectLoadFailure } from "@stackyard/project-loader";
import { Effect, Option } from "effect";
import { Argument, Flag } from "effect/unstable/cli";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import { writeProjectEvaluationOutput } from "./project-output.ts";

export interface InspectCommandDependencies<R = never> {
  readonly diagnostics: DiagnosticSink;
  loadProject(path: string | undefined): Effect.Effect<LoadedProject, ProjectLoadFailure, R>;
  writeError(output: string): void;
  writeOutput(output: string): void;
}

export function createInspectCommand<R>(
  dependencies: InspectCommandDependencies<R>,
): CliCommand<R> {
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

const runInspect = Effect.fn("inspectProject")(function* <R>(
  path: string | undefined,
  json: boolean,
  dependencies: InspectCommandDependencies<R>,
): Effect.fn.Return<number, never, R> {
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
