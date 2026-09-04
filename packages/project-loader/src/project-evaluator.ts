import type { Failure } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { Context, Effect } from "effect";

import type { CapturedProcessOutput } from "./process-output.ts";

export interface ProjectEvaluationInput {
  readonly entrypoint: string;
  readonly projectRoot: string;
}

export interface ProjectEvaluation {
  readonly spec: ProjectSpec;
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export interface ProjectEvaluationFailure extends Failure {
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export class ProjectEvaluator extends Context.Service<
  ProjectEvaluator,
  {
    readonly evaluate: (
      input: ProjectEvaluationInput,
    ) => Effect.Effect<ProjectEvaluation, ProjectEvaluationFailure>;
  }
>()("stackyard/project-loader/ProjectEvaluator") {}

export const evaluateProject = Effect.fn("evaluateProject")(function* (
  input: ProjectEvaluationInput,
) {
  const evaluator = yield* ProjectEvaluator;
  return yield* evaluator.evaluate(input);
});
