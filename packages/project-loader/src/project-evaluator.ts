import type { Result } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { CapturedProcessOutput } from "./process-output.ts";

export interface ProjectEvaluationInput {
  readonly entrypoint: string;
  readonly projectRoot: string;
}

export interface ProjectEvaluationOutput {
  readonly result: Result<ProjectSpec>;
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export class ProjectEvaluator extends Context.Service<
  ProjectEvaluator,
  {
    readonly evaluate: (input: ProjectEvaluationInput) => Effect.Effect<ProjectEvaluationOutput>;
  }
>()("stackyard/project-loader/ProjectEvaluator") {}

export const evaluateProject = Effect.fn("evaluateProject")(function* (
  input: ProjectEvaluationInput,
) {
  const evaluator = yield* ProjectEvaluator;
  return yield* evaluator.evaluate(input);
});
