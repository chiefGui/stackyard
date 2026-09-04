import { createDiagnostic, describeError, failure, type Failure } from "@stackyard/diagnostics";
import { Context, Effect, Fiber, Layer, Option, Schema, Scope } from "effect";

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
  type ProjectEvaluation,
  type ProjectEvaluationFailure,
  type ProjectEvaluationInput,
} from "./project-evaluator.ts";
import { projectEvaluatorCommand } from "./worker-command.ts";

const evaluationTimeoutMilliseconds = 10_000;

class EvaluatorInfrastructureError extends Schema.TaggedError<EvaluatorInfrastructureError>()(
  "EvaluatorInfrastructureError",
  { cause: Schema.Defect() },
) {}

interface EvaluatorProcess {
  readonly message: EvaluationMessage | undefined;
  readonly stderr: Fiber.Fiber<CapturedProcessOutput, EvaluatorInfrastructureError>;
  readonly stdout: Fiber.Fiber<CapturedProcessOutput, EvaluatorInfrastructureError>;
  readonly subprocess: ReturnType<typeof spawnEvaluator>;
}

export const ProjectEvaluationTimeout = Context.Reference<number>(
  "stackyard/project-loader/ProjectEvaluationTimeout",
  { defaultValue: () => evaluationTimeoutMilliseconds },
);

export function makeBunProjectEvaluatorLayer(evaluatorEntrypoint: string) {
  const evaluate = Effect.fn("BunProjectEvaluator.evaluate")(function* (
    input: ProjectEvaluationInput,
  ) {
    const timeoutMilliseconds = yield* ProjectEvaluationTimeout;
    let evaluator: EvaluatorProcess | undefined;
    return yield* Effect.gen(function* () {
      evaluator = yield* Effect.acquireRelease(
        createEvaluator(evaluatorEntrypoint, input.entrypoint, input.projectRoot),
        ({ subprocess }) => terminateSubprocess(subprocess),
      );
      return yield* evaluateRunningProject(evaluator, timeoutMilliseconds);
    }).pipe(
      Effect.scoped,
      Effect.catchTag("EvaluatorInfrastructureError", (error) =>
        recoverEvaluation(error, evaluator),
      ),
    );
  });

  return Layer.succeed(ProjectEvaluator, ProjectEvaluator.of({ evaluate }));
}

const evaluateRunningProject = Effect.fn("evaluateRunningProject")(function* (
  evaluator: EvaluatorProcess,
  timeoutMilliseconds: number,
): Effect.fn.Return<ProjectEvaluation, ProjectEvaluationFailure | EvaluatorInfrastructureError> {
  const exitCode = yield* Effect.tryPromise({
    try: () => evaluator.subprocess.exited,
    catch: (cause) => new EvaluatorInfrastructureError({ cause }),
  }).pipe(Effect.timeoutOption(`${timeoutMilliseconds} millis`));

  if (Option.isNone(exitCode)) {
    yield* terminateSubprocess(evaluator.subprocess);
  }

  const [stderr, stdout] = yield* Effect.all(
    [Fiber.join(evaluator.stderr), Fiber.join(evaluator.stdout)],
    { concurrency: "unbounded" },
  );

  if (Option.isNone(exitCode)) {
    return yield* evaluationFailure(
      failure(
        createDiagnostic({
          code: "SYD2001",
          help: "Remove blocking top-level work from stackyard/main.ts and retry.",
          message: `Project evaluation exceeded ${timeoutMilliseconds / 1_000} seconds.`,
        }),
      ),
      stderr,
      stdout,
    );
  }

  if (!evaluator.message) {
    return yield* evaluationFailure(
      failure(
        createDiagnostic({
          code: "SYD2002",
          help: "Remove top-level process exits from stackyard/main.ts and retry.",
          message: "Project evaluator exited without returning a result.",
          notes: [`Evaluator exit code: ${exitCode.value}.`],
        }),
      ),
      stderr,
      stdout,
    );
  }

  if (!evaluator.message.result.success) {
    return yield* evaluationFailure(evaluator.message.result, stderr, stdout);
  }
  return { spec: evaluator.message.result.output, stderr, stdout };
});

const recoverEvaluation = Effect.fn("recoverEvaluation")(function* (
  error: EvaluatorInfrastructureError,
  evaluator?: EvaluatorProcess,
): Effect.fn.Return<never, ProjectEvaluationFailure> {
  const [stderr, stdout] = yield* Effect.all(
    [recoverCapturedOutput(evaluator?.stderr), recoverCapturedOutput(evaluator?.stdout)],
    { concurrency: "unbounded" },
  );
  return yield* evaluationFailure(
    failure(
      createDiagnostic({
        code: "SYD2007",
        help: "Retry the command; if it persists, report this diagnostic and its notes.",
        message: "Project evaluator failed because of an infrastructure error.",
        notes: [describeError(error.cause)],
      }),
    ),
    stderr,
    stdout,
  );
});

const createEvaluator = Effect.fn("createEvaluator")(function* (
  evaluatorEntrypoint: string,
  entrypoint: string,
  projectRoot: string,
): Effect.fn.Return<EvaluatorProcess, EvaluatorInfrastructureError, Scope.Scope> {
  const state: { message: EvaluationMessage | undefined } = { message: undefined };
  const subprocess = yield* Effect.try({
    try: () =>
      spawnEvaluator(evaluatorEntrypoint, entrypoint, projectRoot, (value) => {
        const message = readEvaluationMessage(value);
        if (message) {
          state.message = message;
          acknowledgeEvaluation(subprocess);
        }
      }),
    catch: (cause) => new EvaluatorInfrastructureError({ cause }),
  });
  const capture = (stream: ReadableStream<Uint8Array>) =>
    captureProcessOutput(stream).pipe(
      Effect.mapError((cause) => new EvaluatorInfrastructureError({ cause })),
      Effect.forkScoped,
    );
  const stderr = yield* capture(subprocess.stderr);
  const stdout = yield* capture(subprocess.stdout);
  return {
    get message() {
      return state.message;
    },
    stderr,
    stdout,
    subprocess,
  };
});

function recoverCapturedOutput(
  output: Fiber.Fiber<CapturedProcessOutput, EvaluatorInfrastructureError> | undefined,
): Effect.Effect<CapturedProcessOutput> {
  return output
    ? Fiber.join(output).pipe(Effect.catch(() => Effect.succeed(emptyCapturedProcessOutput())))
    : Effect.succeed(emptyCapturedProcessOutput());
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
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        try {
          if (subprocess.exitCode === null) {
            subprocess.kill("SIGKILL");
          }
        } catch {
          // The process may have become unavailable between inspection and termination.
        }
      });
      yield* Effect.promise(() => subprocess.exited.catch(() => undefined));
    }),
);

function evaluationFailure(
  failed: Failure,
  stderr: CapturedProcessOutput,
  stdout: CapturedProcessOutput,
): Effect.Effect<never, ProjectEvaluationFailure> {
  return Effect.fail(Object.freeze({ ...failed, stderr, stdout }));
}
