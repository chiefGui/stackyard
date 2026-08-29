import {
  createDiagnostic,
  failure,
  isNonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";
import { parseProjectSpec, type ProjectSpec } from "@stackyard/protocol";

import {
  captureProcessOutput,
  emptyCapturedProcessOutput,
  type CapturedProcessOutput,
} from "./process-output.ts";
import { projectEvaluatorCommand } from "./worker-command.ts";

const evaluationTimeoutMilliseconds = 10_000;
const evaluationMessageType = "stackyard:evaluation";

export interface EvaluationOutput {
  readonly result: Result<ProjectSpec>;
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

interface EvaluationMessage {
  readonly result: Result<ProjectSpec>;
  readonly type: typeof evaluationMessageType;
}

export async function evaluateProject(
  evaluatorEntrypoint: string,
  entrypoint: string,
  projectRoot: string,
): Promise<EvaluationOutput> {
  let message: EvaluationMessage | undefined;
  let subprocess: ReturnType<typeof spawnEvaluator> | undefined;
  let stderrPromise: Promise<CapturedProcessOutput> | undefined;
  let stdoutPromise: Promise<CapturedProcessOutput> | undefined;

  try {
    subprocess = spawnEvaluator(evaluatorEntrypoint, entrypoint, projectRoot, (value) => {
      if (isEvaluationMessage(value)) {
        message = value;
      }
    });

    stderrPromise = captureProcessOutput(subprocess.stderr);
    stdoutPromise = captureProcessOutput(subprocess.stdout);
    const timedOut = await didTimeOut(subprocess);

    if (timedOut) {
      subprocess.kill("SIGKILL");
    }

    const exitCode = await subprocess.exited;
    const [stderr, stdout] = await Promise.all([stderrPromise, stdoutPromise]);

    if (timedOut) {
      return {
        result: failure(
          createDiagnostic(
            "SYD2001",
            `Project evaluation exceeded ${evaluationTimeoutMilliseconds / 1_000} seconds.`,
          ),
        ),
        stderr,
        stdout,
      };
    }

    if (!message) {
      return {
        result: failure(
          createDiagnostic(
            "SYD2002",
            `Project evaluator exited with code ${exitCode} without returning a result.`,
          ),
        ),
        stderr,
        stdout,
      };
    }

    if (!message.result.success) {
      return { result: message.result, stderr, stdout };
    }

    return {
      result: parseProjectSpec(message.result.output),
      stderr,
      stdout,
    };
  } catch (error) {
    await terminateSubprocess(subprocess);
    const [stderr, stdout] = await Promise.all([
      recoverCapturedOutput(stderrPromise),
      recoverCapturedOutput(stdoutPromise),
    ]);

    return {
      result: failure(
        createDiagnostic(
          "SYD2007",
          error instanceof Error
            ? `Project evaluator failed: ${error.message}`
            : "Project evaluator failed with an unknown infrastructure error.",
        ),
      ),
      stderr,
      stdout,
    };
  }
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

async function terminateSubprocess(
  subprocess: ReturnType<typeof spawnEvaluator> | undefined,
): Promise<void> {
  if (!subprocess) {
    return;
  }

  try {
    if (subprocess.exitCode === null) {
      subprocess.kill("SIGKILL");
    }
  } catch {
    // The process may have become unavailable between inspection and termination.
  }

  await subprocess.exited.catch(() => undefined);
}

export function createEvaluationMessage(result: Result<ProjectSpec>): EvaluationMessage {
  return { result, type: evaluationMessageType };
}

function isEvaluationMessage(value: unknown): value is EvaluationMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("type" in value) || value.type !== evaluationMessageType || !("result" in value)) {
    return false;
  }

  return isEvaluationResult(value.result);
}

function isEvaluationResult(value: unknown): value is Result<ProjectSpec> {
  if (typeof value !== "object" || value === null || !("success" in value)) {
    return false;
  }

  if (value.success === true) {
    return "output" in value;
  }

  return (
    value.success === false && "diagnostics" in value && isNonEmptyDiagnostics(value.diagnostics)
  );
}

async function didTimeOut(subprocess: Bun.Subprocess): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const timedOut = new Promise<true>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(true), evaluationTimeoutMilliseconds);
    });
    const exited = subprocess.exited.then(() => false as const);

    return await Promise.race([exited, timedOut]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
