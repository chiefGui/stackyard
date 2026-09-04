import type { Failure } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { Effect, FileSystem, Path } from "effect";

import { discoverProject, type ProjectLocation } from "./discovery.ts";
import { emptyCapturedProcessOutput, type CapturedProcessOutput } from "./process-output.ts";
import { evaluateProject, type ProjectEvaluator } from "./project-evaluator.ts";

export interface ProjectLoadInput {
  readonly currentDirectory: string;
  readonly path?: string;
}

export interface LoadedProject {
  readonly location: ProjectLocation;
  readonly spec: ProjectSpec;
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export interface ProjectLoadFailure extends Failure {
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export const loadProjectEffect = Effect.fn("loadProjectEffect")(function* (
  options: ProjectLoadInput,
): Effect.fn.Return<
  LoadedProject,
  ProjectLoadFailure,
  FileSystem.FileSystem | Path.Path | ProjectEvaluator
> {
  const location = yield* discoverProject(options.path, options.currentDirectory).pipe(
    Effect.mapError((failed) =>
      Object.freeze({
        ...failed,
        stderr: emptyCapturedProcessOutput(),
        stdout: emptyCapturedProcessOutput(),
      }),
    ),
  );
  const evaluation = yield* evaluateProject({
    entrypoint: location.entrypoint,
    projectRoot: location.root,
  });
  return {
    location,
    spec: evaluation.spec,
    stderr: evaluation.stderr,
    stdout: evaluation.stdout,
  };
});
