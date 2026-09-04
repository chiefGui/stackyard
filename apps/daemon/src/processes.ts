import { resolve } from "node:path";

import {
  ProcessHost,
  type ProcessExit,
  type ProcessHandle,
  type ProcessStart,
} from "@stackyard/control-plane";
import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type DiagnosticSink,
  type Failure,
  type Result,
} from "@stackyard/diagnostics";
import { Deferred, Effect, Fiber, Layer, Option, Scope, Semaphore } from "effect";

import { superviseCleanup } from "./cleanup.ts";
import { captureProcessLogs } from "./process-output.ts";
import { createWindowsJob, type WindowsJob } from "./windows-job.ts";

const gracefulShutdownMilliseconds = 2_000;
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

export function makeBunProcessHostLayer(diagnostics: DiagnosticSink): Layer.Layer<ProcessHost> {
  return Layer.effect(
    ProcessHost,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      return ProcessHost.of({
        start: (input) => startProcess(input, diagnostics, scope),
      });
    }),
  );
}

const startProcess = Effect.fn("BunProcessHost.start")(function* (
  input: ProcessStart,
  diagnostics: DiagnosticSink,
  scope: Scope.Scope,
): Effect.fn.Return<ProcessHandle, Failure> {
  let cancellationCleanup: Effect.Effect<void> = Effect.void;
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const subprocess = yield* Effect.try({
        try: () => {
          const environment = { ...input.env };
          if (process.platform === "win32") {
            environment[windowsStartVariable] = JSON.stringify({
              args: input.args,
              executable: input.executable,
            });
          }
          return Bun.spawn({
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
        },
        catch: (error) => startFailure(input.executable, error),
      });
      cancellationCleanup = superviseCleanup(stopUnownedProcess(subprocess), diagnostics);

      const capture = yield* Effect.forkIn(
        captureProcessLogs(subprocess.stdout, subprocess.stderr, input.logs).pipe(toResultEffect),
        scope,
      );
      const ownership = yield* ownWindowsProcess(subprocess).pipe(
        Effect.flatMap((windowsJob) =>
          makeRetriableStop(subprocess, windowsJob).pipe(
            Effect.tap((stop) =>
              Effect.sync(() => {
                cancellationCleanup = superviseCleanup(stop, diagnostics);
              }),
            ),
            Effect.flatMap((stop) =>
              startOwnedProcess(subprocess, windowsJob).pipe(Effect.as(stop)),
            ),
          ),
        ),
        Effect.match({
          onFailure: (error) => ({ error, success: false as const }),
          onSuccess: (stop) => ({ stop, success: true as const }),
        }),
      );
      if (!ownership.success) {
        yield* Fiber.interrupt(capture);
        yield* cancellationCleanup;
        return yield* Effect.fail(startFailure(input.executable, ownership.error));
      }

      const { stop } = ownership;
      const exited = yield* Effect.cached(
        Effect.promise(() => subprocess.exited).pipe(
          Effect.flatMap((exitCode) =>
            superviseCleanup(stop, diagnostics).pipe(
              Effect.andThen(Fiber.join(capture)),
              Effect.map((logCapture): ProcessExit =>
                Object.freeze({ cleanup: success(undefined), exitCode, logCapture }),
              ),
            ),
          ),
        ),
      );
      yield* Scope.addFinalizer(scope, cancellationCleanup);

      return yield* restore(
        Effect.succeed(
          Object.freeze({
            exited,
            leaderExited: Effect.promise(() => subprocess.exited),
            pid: subprocess.pid,
            stop,
          }),
        ),
      );
    }).pipe(Effect.onInterrupt(() => cancellationCleanup)),
  );
});

const makeRetriableStop = Effect.fn("BunProcessHost.makeRetriableStop")(function* (
  subprocess: Bun.Subprocess,
  windowsJob: WindowsJob | undefined,
): Effect.fn.Return<Effect.Effect<void, Failure>> {
  const mutation = yield* Semaphore.make(1);
  let stopping: Deferred.Deferred<Result<void>> | undefined;

  return Effect.suspend(() =>
    Effect.gen(function* () {
      const proposed = yield* Deferred.make<Result<void>>();
      const selected = yield* mutation.withPermits(1)(
        Effect.sync(() => {
          if (stopping) {
            return { owner: false as const, result: stopping };
          }
          stopping = proposed;
          return { owner: true as const, result: proposed };
        }),
      );
      if (!selected.owner) {
        return yield* Deferred.await(selected.result).pipe(Effect.flatMap(fromResultEffect));
      }

      const result = yield* stopProcess(subprocess, windowsJob).pipe(toResultEffect);
      yield* Deferred.succeed(proposed, result);
      if (!result.success) {
        yield* mutation.withPermits(1)(
          Effect.sync(() => {
            if (stopping === proposed) {
              stopping = undefined;
            }
          }),
        );
        return yield* Effect.fail(result);
      }
      return undefined;
    }),
  );
});

const startOwnedProcess = Effect.fn("BunProcessHost.startOwnedProcess")(function* (
  subprocess: Bun.Subprocess,
  windowsJob: WindowsJob | undefined,
): Effect.fn.Return<void, unknown> {
  const stdin = subprocess.stdin;
  if (!stdin || typeof stdin === "number") {
    return yield* Effect.fail(new Error("The service host does not have its startup pipe."));
  }
  const started = yield* Effect.tryPromise({
    try: async () => {
      if (process.platform === "win32") {
        await stdin.write("start\n");
        await stdin.end();
      } else {
        await stdin.write("start\n");
        await stdin.flush();
      }
    },
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (started.success) {
    return undefined;
  }

  const cleanup = yield* stopProcess(subprocess, windowsJob).pipe(toResultEffect);
  if (!cleanup.success) {
    return yield* Effect.fail(
      new AggregateError(
        [started.error],
        `The service host could not start or stop: ${cleanup.diagnostics.map(({ message }) => message).join(" ")}`,
        { cause: started.error },
      ),
    );
  }
  return yield* Effect.fail(
    new AggregateError([started.error], "The service host could not start.", {
      cause: started.error,
    }),
  );
});

const stopProcess = Effect.fn("BunProcessHost.stopProcess")(
  (subprocess: Bun.Subprocess, windowsJob: WindowsJob | undefined): Effect.Effect<void, Failure> =>
    (process.platform === "win32"
      ? windowsJob
        ? stopWindowsTree(subprocess, windowsJob)
        : Effect.fail(new Error("The service does not have a Windows Job Object."))
      : stopPosixGroup(subprocess.pid)
    ).pipe(Effect.mapError((error) => stopFailure(subprocess.pid, error))),
);

const stopUnownedProcess = Effect.fn("BunProcessHost.stopUnownedProcess")(
  (subprocess: Bun.Subprocess): Effect.Effect<void, Failure> =>
    (process.platform === "win32"
      ? stopUnownedWindowsProcess(subprocess)
      : stopPosixGroup(subprocess.pid)
    ).pipe(Effect.mapError((error) => stopFailure(subprocess.pid, error))),
);

const ownWindowsProcess = Effect.fn("BunProcessHost.ownWindowsProcess")(function* (
  subprocess: Bun.Subprocess,
): Effect.fn.Return<WindowsJob | undefined, unknown> {
  if (process.platform !== "win32") {
    return undefined;
  }
  const owned = yield* Effect.try({
    try: () => createWindowsJob(subprocess.pid),
    catch: (error) => error,
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: (job) => ({ job, success: true as const }),
    }),
  );
  if (owned.success) {
    return owned.job;
  }

  const cleanup = yield* stopUnownedWindowsProcess(subprocess).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (!cleanup.success) {
    return yield* Effect.fail(
      new AggregateError(
        [owned.error, cleanup.error],
        "Windows process ownership and cleanup both failed.",
        { cause: cleanup.error },
      ),
    );
  }
  return yield* Effect.fail(owned.error);
});

const stopUnownedWindowsProcess = Effect.fn("BunProcessHost.stopUnownedWindowsProcess")(function* (
  subprocess: Bun.Subprocess,
): Effect.fn.Return<void, unknown> {
  const killed = yield* taskkill(subprocess.pid, true);
  if (killed !== 0 && subprocess.exitCode === null) {
    yield* Effect.try({ try: () => subprocess.kill("SIGKILL"), catch: (error) => error });
  }
  if (!(yield* processExitsWithin(subprocess, gracefulShutdownMilliseconds))) {
    return yield* Effect.fail(
      new Error(`Process ${subprocess.pid} remained alive after forced cleanup.`),
    );
  }
  return undefined;
});

const stopWindowsTree = Effect.fn("BunProcessHost.stopWindowsTree")(function* (
  subprocess: Bun.Subprocess,
  job: WindowsJob,
): Effect.fn.Return<void, unknown> {
  if (subprocess.exitCode === null) {
    const signaled = yield* taskkill(subprocess.pid, false);
    if (signaled === 0) {
      yield* processExitsWithin(subprocess, gracefulShutdownMilliseconds);
    }
  }
  yield* Effect.try({ try: () => job.terminate(), catch: (error) => error });
  yield* Effect.promise(() => subprocess.exited);
});

const stopPosixGroup = Effect.fn("BunProcessHost.stopPosixGroup")(function* (
  pid: number,
): Effect.fn.Return<void, unknown> {
  if (
    !isProcessGroupAlive(pid) ||
    !(yield* Effect.try({
      try: () => signalProcessGroup(pid, "SIGTERM"),
      catch: (error) => error,
    }))
  ) {
    return undefined;
  }
  if (yield* groupExitsWithin(pid, gracefulShutdownMilliseconds)) {
    return undefined;
  }
  if (
    !(yield* Effect.try({
      try: () => signalProcessGroup(pid, "SIGKILL"),
      catch: (error) => error,
    }))
  ) {
    return undefined;
  }
  if (!(yield* groupExitsWithin(pid, gracefulShutdownMilliseconds))) {
    return yield* Effect.fail(new Error(`Process group ${pid} remained alive after SIGKILL.`));
  }
  return undefined;
});

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

const taskkill = Effect.fn("BunProcessHost.taskkill")((pid: number, force: boolean) =>
  Effect.try({
    try: () => {
      const command = ["taskkill", "/PID", String(pid), "/T"];
      if (force) {
        command.push("/F");
      }
      return Bun.spawn({
        cmd: command,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
        windowsHide: true,
      });
    },
    catch: (error) => error,
  }).pipe(Effect.flatMap((task) => Effect.promise(() => task.exited))),
);

const processExitsWithin = Effect.fn("BunProcessHost.processExitsWithin")(
  (subprocess: Bun.Subprocess, milliseconds: number): Effect.Effect<boolean> =>
    Effect.promise(() => subprocess.exited).pipe(
      Effect.as(true),
      Effect.timeoutOption(`${milliseconds} millis`),
      Effect.map(Option.isSome),
    ),
);

const groupExitsWithin = Effect.fn("BunProcessHost.groupExitsWithin")(function* (
  pid: number,
  milliseconds: number,
) {
  const attempts = Math.ceil(milliseconds / 25);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isProcessGroupAlive(pid)) {
      return true;
    }
    yield* Effect.sleep("25 millis");
  }
  return !isProcessGroupAlive(pid);
});

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isProcessError(error) && error.code === "EPERM";
  }
}

function isProcessError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function startFailure(executable: string, error: unknown): Failure {
  return failure(
    createDiagnostic({
      code: "SYD4003",
      help: "Verify the command and working directory, then retry.",
      message: `Service command '${executable}' could not start.`,
      notes: [describeError(error)],
    }),
  );
}

function stopFailure(pid: number, error: unknown): Failure {
  return failure(
    createDiagnostic({
      code: "SYD4004",
      help: `Stop process group ${pid} before retrying.`,
      message: "A service process tree did not stop cleanly.",
      notes: [describeError(error)],
    }),
  );
}

function fromResultEffect<T>(result: Result<T>): Effect.Effect<T, Failure> {
  return result.success ? Effect.succeed(result.output) : Effect.fail(result);
}

function toResultEffect<T>(effect: Effect.Effect<T, Failure>): Effect.Effect<Result<T>> {
  return effect.pipe(Effect.match({ onFailure: (value) => value, onSuccess: success }));
}
