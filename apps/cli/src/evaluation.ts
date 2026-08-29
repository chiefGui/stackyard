import {
  parseProjectSpec,
  type Diagnostic,
  type ProjectSpec,
  type Result,
} from "@stackyard/protocol";

const evaluationTimeoutMilliseconds = 10_000;
const evaluationMessageType = "stackyard:evaluation";

export interface EvaluationOutput {
  readonly result: Result<ProjectSpec>;
  readonly stderr: string;
  readonly stdout: string;
}

interface EvaluationMessage {
  readonly result: Result<ProjectSpec>;
  readonly type: typeof evaluationMessageType;
}

export async function evaluateProject(
  cliEntrypoint: string,
  entrypoint: string,
  projectRoot: string,
): Promise<EvaluationOutput> {
  let message: EvaluationMessage | undefined;

  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntrypoint, "__stackyard_evaluate__", entrypoint],
    cwd: projectRoot,
    ipc(value) {
      if (isEvaluationMessage(value)) {
        message = value;
      }
    },
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });

  const stderrPromise = new Response(subprocess.stderr).text();
  const stdoutPromise = new Response(subprocess.stdout).text();
  const timedOut = await didTimeOut(subprocess);

  if (timedOut) {
    subprocess.kill("SIGKILL");
  }

  const exitCode = await subprocess.exited;
  const [stderr, stdout] = await Promise.all([stderrPromise, stdoutPromise]);

  if (timedOut) {
    return {
      result: failure(
        "SYD2001",
        `Project evaluation exceeded ${evaluationTimeoutMilliseconds / 1_000} seconds.`,
      ),
      stderr,
      stdout,
    };
  }

  if (!message) {
    return {
      result: failure(
        "SYD2002",
        `Project evaluator exited with code ${exitCode} without returning a result.`,
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
    value.success === false &&
    "diagnostics" in value &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "path" in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === "string" || typeof segment === "number")
  );
}

function failure(code: string, message: string): Result<ProjectSpec> {
  const diagnostic: Diagnostic = { code, message, path: [] };
  return { diagnostics: [diagnostic], success: false };
}

async function didTimeOut(subprocess: Bun.Subprocess): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timedOut = new Promise<true>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout(true), evaluationTimeoutMilliseconds);
  });
  const exited = subprocess.exited.then(() => false as const);
  const result = await Promise.race([exited, timedOut]);

  if (timeout) {
    clearTimeout(timeout);
  }

  return result;
}
