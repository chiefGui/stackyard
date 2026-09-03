import { success, type Result } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import * as Effect from "effect/Effect";

import { makeBunProjectEvaluatorLayer } from "./bun-project-evaluator.ts";
import { discoverProject, type ProjectLocation } from "./discovery.ts";
import { emptyCapturedProcessOutput, type CapturedProcessOutput } from "./process-output.ts";
import { evaluateProject, type ProjectEvaluator } from "./project-evaluator.ts";

export interface ProjectLoadInput {
  readonly currentDirectory: string;
  readonly path?: string;
}

export interface LoadProjectOptions extends ProjectLoadInput {
  readonly evaluatorEntrypoint: string;
}

export interface LoadedProject {
  readonly location: ProjectLocation;
  readonly spec: ProjectSpec;
}

export interface ProjectLoadOutcome {
  readonly result: Result<LoadedProject>;
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export const loadProjectEffect = Effect.fn("loadProjectEffect")(function* (
  options: ProjectLoadInput,
): Effect.fn.Return<ProjectLoadOutcome, never, ProjectEvaluator> {
  const location = yield* Effect.promise(() =>
    discoverProject(options.path, options.currentDirectory),
  );

  if (!location.success) {
    return {
      result: location,
      stderr: emptyCapturedProcessOutput(),
      stdout: emptyCapturedProcessOutput(),
    };
  }

  const evaluation = yield* evaluateProject({
    entrypoint: location.output.entrypoint,
    projectRoot: location.output.root,
  });

  if (!evaluation.result.success) {
    return {
      result: evaluation.result,
      stderr: evaluation.stderr,
      stdout: evaluation.stdout,
    };
  }

  return {
    result: success({ location: location.output, spec: evaluation.result.output }),
    stderr: evaluation.stderr,
    stdout: evaluation.stdout,
  };
});

export function loadProject(options: LoadProjectOptions): Promise<ProjectLoadOutcome> {
  return Effect.runPromise(
    loadProjectEffect(options).pipe(
      Effect.provide(makeBunProjectEvaluatorLayer(options.evaluatorEntrypoint)),
    ),
  );
}
