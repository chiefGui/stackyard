import { createDiagnostic, describeError, failure } from "@stackyard/diagnostics";
import type { UnknownError } from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  createEvaluationAcknowledgement,
  readEvaluationMessage,
  type EvaluationMessage,
} from "./evaluation-protocol.ts";
import {
  captureProcessOutput,
  emptyCapturedProcessOutput,
  type CapturedProcessOutput,
} from "./process-output.ts";
import {
  ProjectEvaluator,
  type ProjectEvaluationInput,
  type ProjectEvaluationOutput,
} from "./project-evaluator.ts";
import { projectEvaluatorCommand } from "./worker-command.ts";

const evaluationTimeoutMilliseconds = 10_000;

interface EvaluatorProcess {
  readonly message: EvaluationMessage | undefined;
  readonly stderr: Promise<CapturedProcessOutput>;
  readonly stdout: Promise<CapturedProcessOutput>;
  readonly subprocess: ReturnType<typeof spawnEvaluator>;
}

export const ProjectEvaluationTimeout = Context.Reference<number>(
  "stackyard/project-loader/ProjectEvaluationTimeout",
  { defaultValue: () => evaluationTimeoutMilliseconds },
);

export function makeBunProjectEvaluatorLayer(evaluatorEntrypoint: string) {
  const evaluate = Effect.fn("BunProjectEvaluator.evaluate")(
    function* (input: ProjectEvaluationInput) {
      const timeoutMilliseconds = yield* ProjectEvaluationTimeout;
      const evaluator = yield* Effect.acquireRelease(
        Effect.try(() => createEvaluator(evaluatorEntrypoint, input.entrypoint, input.projectRoot)),
        ({ subprocess }) => terminateSubprocess(subprocess),
      );

      return yield* evaluateRunningProject(evaluator, timeoutMilliseconds).pipe(
        Effect.catchTag("UnknownError", (error) => recoverEvaluation(error, evaluator)),
      );
    },
    Effect.scoped,
    Effect.catchTag("UnknownError", (error) => recoverEvaluation(error)),
  );

  return Layer.succeed(ProjectEvaluator, ProjectEvaluator.of({ evaluate }));
}

const evaluateRunningProject = Effect.fn("evaluateRunningProject")(function* (
  evaluator: EvaluatorProcess,
  timeoutMilliseconds: number,
) {
  const exitCode = yield* Effect.tryPromise(() => evaluator.subprocess.exited).pipe(
    Effect.timeoutOption(timeoutMilliseconds),
  );

  if (Option.isNone(exitCode)) {
    yield* terminateSubprocess(evaluator.subprocess);
  }

  const [stderr, stdout] = yield* Effect.tryPromise(() =>
    Promise.all([evaluator.stderr, evaluator.stdout]),
  );

  if (Option.isNone(exitCode)) {
    return {
      result: failure(
        createDiagnostic({
          code: "SYD2001",
          help: "Remove blocking top-level work from stackyard/main.ts and retry.",
          message: `Project evaluation exceeded ${timeoutMilliseconds / 1_000} seconds.`,
        }),
      ),
      stderr,
      stdout,
    };
  }

  if (!evaluator.message) {
    return {
      result: failure(
        createDiagnostic({
          code: "SYD2002",
          help: "Remove top-level process exits from stackyard/main.ts and retry.",
          message: "Project evaluator exited without returning a result.",
          notes: [`Evaluator exit code: ${exitCode.value}.`],
        }),
      ),
      stderr,
      stdout,
    };
  }

  return { result: evaluator.message.result, stderr, stdout };
});

const recoverEvaluation = Effect.fn("recoverEvaluation")(
  (error: UnknownError, evaluator?: EvaluatorProcess): Effect.Effect<ProjectEvaluationOutput> =>
    Effect.promise(async () => {
      const [stderr, stdout] = await Promise.all([
        recoverCapturedOutput(evaluator?.stderr),
        recoverCapturedOutput(evaluator?.stdout),
      ]);
      return {
        result: failure(
          createDiagnostic({
            code: "SYD2007",
            help: "Retry the command; if it persists, report this diagnostic and its notes.",
            message: "Project evaluator failed because of an infrastructure error.",
            notes: [describeError(error.cause)],
          }),
        ),
        stderr,
        stdout,
      };
    }),
);

function createEvaluator(
  evaluatorEntrypoint: string,
  entrypoint: string,
  projectRoot: string,
): EvaluatorProcess {
  const state: { message: EvaluationMessage | undefined } = { message: undefined };
  const subprocess = spawnEvaluator(evaluatorEntrypoint, entrypoint, projectRoot, (value) => {
    const message = readEvaluationMessage(value);
    if (message) {
      state.message = message;
      acknowledgeEvaluation(subprocess);
    }
  });
  return {
    get message() {
      return state.message;
    },
    stderr: captureProcessOutput(subprocess.stderr),
    stdout: captureProcessOutput(subprocess.stdout),
    subprocess,
  };
}

async function recoverCapturedOutput(
  output: Promise<CapturedProcessOutput> | undefined,
): Promise<CapturedProcessOutput> {
  return output ? output.catch(() => emptyCapturedProcessOutput()) : emptyCapturedProcessOutput();
}

function spawnEvaluator(
  evaluatorEntrypoint: string,
  entrypoint: string,
  projectRoot: string,
  receiveMessage: (value: unknown) => void,
) {
  return Bun.spawn({
    cmd: [process.execPath, evaluatorEntrypoint, projectEvaluatorCommand, entrypoint],
    cwd: projectRoot,
    ipc: receiveMessage,
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
}

function acknowledgeEvaluation(subprocess: ReturnType<typeof spawnEvaluator>): void {
  try {
    subprocess.send(createEvaluationAcknowledgement());
  } catch {
    try {
      if (subprocess.exitCode === null) {
        subprocess.kill("SIGKILL");
      }
    } catch {
      // The scoped finalizer performs the definitive cleanup attempt.
    }
  }
}

const terminateSubprocess = Effect.fn("terminateSubprocess")(
  (subprocess: ReturnType<typeof spawnEvaluator>) =>
    Effect.promise(async () => {
      try {
        if (subprocess.exitCode === null) {
          subprocess.kill("SIGKILL");
        }
      } catch {
        // The process may have become unavailable between inspection and termination.
      }

      await subprocess.exited.catch(() => undefined);
    }),
);
