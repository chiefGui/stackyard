import { resolve } from "node:path";

import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";
import type {
  ProcessExit,
  ProcessHandle,
  ProcessHost,
  ProcessOutput,
  ProcessStart,
} from "@stackyard/control-plane";

import { superviseCleanup } from "./cleanup.ts";
import { createWindowsJob, type WindowsJob } from "./windows-job.ts";

/* oxlint-disable eslint/no-await-in-loop -- Streams and process-group liveness are consumed sequentially. */

const gracefulShutdownMilliseconds = 2_000;
const outputLimitBytes = 16 * 1024;
const windowsStartVariable = "STACKYARD_PROCESS_START";
const windowsServiceHost = `
const authorization = await Bun.stdin.text();
if (authorization !== "start\\n") process.exit(125);
const input = JSON.parse(process.env.${windowsStartVariable} ?? "");
delete process.env.${windowsStartVariable};
const child = Bun.spawn({
  cmd: [input.executable, ...input.args],
  env: process.env,
  stderr: "inherit",
  stdin: "ignore",
  stdout: "inherit",
  windowsHide: true,
});
process.exitCode = await child.exited;
`;
const posixServiceHost = `
exec 3<&0
exec 0<&-
IFS= read -r stackyard_start <&3 || exit 125
[ "$stackyard_start" = "start" ] || exit 125
"$@" </dev/null 3<&- &
stackyard_child=$!
(
  IFS= read -r stackyard_keepalive <&3
  kill -KILL -$$
) 3<&3 &
stackyard_watchdog=$!
wait "$stackyard_child"
stackyard_status=$?
kill -KILL "$stackyard_watchdog" 2>/dev/null
wait "$stackyard_watchdog" 2>/dev/null
exit "$stackyard_status"
`;

export class BunProcessHost implements ProcessHost {
  constructor(private readonly diagnostics: DiagnosticSink) {}

  async start(input: ProcessStart): Promise<Result<ProcessHandle>> {
    try {
      const environment = { ...input.env };
      if (process.platform === "win32") {
        environment[windowsStartVariable] = JSON.stringify({
          args: input.args,
          executable: input.executable,
        });
      }
      const subprocess = Bun.spawn({
        cmd:
          process.platform === "win32"
            ? [process.execPath, "-e", windowsServiceHost]
            : [
                "/bin/sh",
                "-c",
                posixServiceHost,
                "stackyard-service",
                input.executable,
                ...input.args,
              ],
        cwd: resolve(input.projectRoot, input.workingDirectory),
        detached: true,
        env: environment,
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
        windowsHide: true,
      });
      const windowsJob = await ownWindowsProcess(subprocess);
      await startOwnedProcess(subprocess, windowsJob);
      const output = Promise.all([
        captureTail(subprocess.stdout, outputLimitBytes),
        captureTail(subprocess.stderr, outputLimitBytes),
      ])
        .then<Result<ProcessOutput>>(([stdout, stderr]) =>
          success(Object.freeze({ stderr, stdout })),
        )
        .catch((error: unknown): Result<ProcessOutput> =>
          failure(
            createDiagnostic({
              code: "SYD4008",
              help: "Restart the service. If the problem persists, check its output streams.",
              message: "Recent service output could not be captured.",
              notes: [describeError(error)],
            }),
          ),
        );
      let stopping: Promise<Result<void>> | undefined;

      const stop = (): Promise<Result<void>> => {
        if (stopping) {
          return stopping;
        }

        const attempt = stopProcess(subprocess, windowsJob);
        stopping = attempt;
        void attempt.then((result) => {
          if (!result.success && stopping === attempt) {
            stopping = undefined;
          }
        });
        return attempt;
      };

      return success(
        Object.freeze({
          exited: subprocess.exited.then(async (exitCode): Promise<ProcessExit> => {
            await superviseCleanup(stop, this.diagnostics);
            return Object.freeze({ cleanup: success(undefined), exitCode });
          }),
          leaderExited: subprocess.exited,
          output,
          pid: subprocess.pid,
          stop,
        }),
      );
    } catch (error) {
      return failure(
        createDiagnostic({
          code: "SYD4003",
          help: "Verify the command and working directory, then retry.",
          message: `Service command '${input.executable}' could not start.`,
          notes: [describeError(error)],
        }),
      );
    }
  }
}

async function startOwnedProcess(
  subprocess: Bun.Subprocess,
  windowsJob: WindowsJob | undefined,
): Promise<void> {
  const stdin = subprocess.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("The service host does not have its startup pipe.");
  }
  try {
    if (process.platform === "win32") {
      await stdin.write("start\n");
      await stdin.end();
    } else {
      await stdin.write("start\n");
      await stdin.flush();
    }
  } catch (error) {
    const cleanup = await stopProcess(subprocess, windowsJob);
    if (!cleanup.success) {
      throw new AggregateError(
        [error],
        `The service host could not start or stop: ${cleanup.diagnostics.map(({ message }) => message).join(" ")}`,
        { cause: error },
      );
    }
    throw new AggregateError([error], "The service host could not start.", { cause: error });
  }
}

async function stopProcess(
  subprocess: Bun.Subprocess,
  windowsJob: WindowsJob | undefined,
): Promise<Result<void>> {
  try {
    if (process.platform === "win32") {
      if (!windowsJob) {
        throw new Error("The service does not have a Windows Job Object.");
      }
      await stopWindowsTree(subprocess, windowsJob);
    } else {
      await stopPosixGroup(subprocess.pid);
    }
    return success(undefined);
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD4004",
        help: `Stop process group ${subprocess.pid} before retrying.`,
        message: "A service process tree did not stop cleanly.",
        notes: [describeError(error)],
      }),
    );
  }
}

async function ownWindowsProcess(subprocess: Bun.Subprocess): Promise<WindowsJob | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    return createWindowsJob(subprocess.pid);
  } catch (ownershipError) {
    try {
      const killed = await taskkill(subprocess.pid, true);
      if (killed !== 0 && subprocess.exitCode === null) {
        subprocess.kill("SIGKILL");
      }
      if (!(await processExitsWithin(subprocess, gracefulShutdownMilliseconds))) {
        throw new Error(`Process ${subprocess.pid} remained alive after forced cleanup.`, {
          cause: ownershipError,
        });
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [ownershipError, cleanupError],
        "Windows process ownership and cleanup both failed.",
        { cause: cleanupError },
      );
    }
    throw ownershipError;
  }
}

async function stopWindowsTree(subprocess: Bun.Subprocess, job: WindowsJob): Promise<void> {
  if (subprocess.exitCode === null) {
    const signaled = await taskkill(subprocess.pid, false);
    if (signaled === 0) {
      await processExitsWithin(subprocess, gracefulShutdownMilliseconds);
    }
  }
  job.terminate();
  await subprocess.exited;
}

async function stopPosixGroup(pid: number): Promise<void> {
  if (!isProcessGroupAlive(pid)) {
    return;
  }
  if (!signalProcessGroup(pid, "SIGTERM")) {
    return;
  }
  if (await groupExitsWithin(pid, gracefulShutdownMilliseconds)) {
    return;
  }
  if (!signalProcessGroup(pid, "SIGKILL")) {
    return;
  }
  if (!(await groupExitsWithin(pid, gracefulShutdownMilliseconds))) {
    throw new Error(`Process group ${pid} remained alive after SIGKILL.`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isProcessError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function taskkill(pid: number, force: boolean): Promise<number> {
  const command = ["taskkill", "/PID", String(pid), "/T"];
  if (force) {
    command.push("/F");
  }
  const task = Bun.spawn({
    cmd: command,
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
    windowsHide: true,
  });
  return task.exited;
}

async function processExitsWithin(
  subprocess: Bun.Subprocess,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((finishTimeout) => {
    timer = setTimeout(() => finishTimeout(false), milliseconds);
  });
  const exited = subprocess.exited.then(() => true as const);
  const result = await Promise.race([exited, timedOut]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}

async function groupExitsWithin(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) {
      return true;
    }
    await Bun.sleep(25);
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isProcessError(error) && error.code === "EPERM";
  }
}

async function captureTail(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  let tail: Uint8Array = new Uint8Array();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    tail = appendTail(tail, chunk.value, limit);
  }
  return new TextDecoder().decode(tail);
}

function appendTail(current: Uint8Array, chunk: Uint8Array, limit: number): Uint8Array {
  if (chunk.byteLength >= limit) {
    return chunk.slice(chunk.byteLength - limit);
  }
  const retained = Math.min(current.byteLength, limit - chunk.byteLength);
  const output = new Uint8Array(retained + chunk.byteLength);
  output.set(current.subarray(current.byteLength - retained));
  output.set(chunk, retained);
  return output;
}

function isProcessError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
