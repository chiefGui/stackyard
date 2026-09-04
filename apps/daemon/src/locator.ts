import { createDiagnostic, describeError, failure, type Failure } from "@stackyard/diagnostics";
import { protocolVersion } from "@stackyard/protocol";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Result as EffectResult,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveStackyardDirectories } from "./directories.ts";

export const internalDaemonCommand = "__stackyard_daemon__";
export const daemonHostname = "127.0.0.1";

const version = 1;
const diagnosticsName = "daemon.log";
const locatorName = "daemon.json";
const lockName = "daemon.lock";

export interface DaemonLocator {
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly protocolVersion: typeof protocolVersion;
  readonly schemaVersion: typeof version;
  readonly token: string;
}

interface LockOwner {
  readonly instanceId: string;
  readonly pid: number;
}

const positiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const port = positiveInteger.check(Schema.isLessThanOrEqualTo(65_535));
const DaemonLocatorSchema = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  pid: positiveInteger,
  port,
  protocolVersion: Schema.Literal(protocolVersion),
  schemaVersion: Schema.Literal(version),
  token: Schema.NonEmptyString,
});
const LocatorProcessSchema = Schema.Struct({
  pid: positiveInteger,
  protocolVersion: Schema.optionalKey(positiveInteger),
});
const LockOwnerSchema = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  pid: positiveInteger,
});
const DaemonHealthSchema = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  protocolVersion: Schema.Literal(protocolVersion),
  status: Schema.Literal("ok"),
});

export interface DaemonLock {
  readonly instanceId: string;
  readonly release: Effect.Effect<void, PlatformError.PlatformError>;
}

export interface EnsureDaemonOptions {
  readonly dashboardWebDirectory: string;
  readonly daemonEntrypoint: string;
  readonly runtimeDirectory?: string;
}

export interface FindDaemonOptions {
  readonly runtimeDirectory?: string;
}

export type StopDaemonStatus = "not-running" | "stopped";

export function daemonUrl(locator: Pick<DaemonLocator, "port">): string {
  return `http://${daemonHostname}:${locator.port}/`;
}

export const findDaemon = Effect.fn("findDaemon")(function* (
  options: FindDaemonOptions = {},
): Effect.fn.Return<
  DaemonLocator | undefined,
  Failure,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const directories = resolveStackyardDirectories(
    options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {},
  );
  return yield* findDaemonInDirectory(directories.runtime);
});

export const ensureDaemon = Effect.fn("ensureDaemon")(function* (
  options: EnsureDaemonOptions,
): Effect.fn.Return<
  DaemonLocator,
  Failure,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directories = resolveStackyardDirectories(
    options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {},
  );
  const directory = directories.runtime;
  yield* fileSystem
    .makeDirectory(directory, { mode: 0o700, recursive: true })
    .pipe(
      Effect.mapError((error) =>
        daemonUnavailable(`The runtime directory could not be created: ${describeError(error)}`),
      ),
    );

  const active = yield* findDaemonInDirectory(directory);
  if (active) {
    return active;
  }

  const diagnosticsPath = path.join(directory, diagnosticsName);
  yield* fileSystem
    .writeFileString(diagnosticsPath, "", { mode: 0o600 })
    .pipe(
      Effect.mapError((error) =>
        daemonUnavailable(
          `The daemon diagnostic log could not be created: ${describeError(error)}`,
        ),
      ),
    );
  const environment = stringEnvironment(process.env);
  environment.STACKYARD_DATA_DIR = directories.data;
  environment.STACKYARD_DIAGNOSTICS_PATH = diagnosticsPath;
  environment.STACKYARD_RUNTIME_DIR = directory;
  environment.STACKYARD_DASHBOARD_WEB_DIR = path.resolve(options.dashboardWebDirectory);

  const spawned = yield* Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make(process.execPath, [options.daemonEntrypoint, internalDaemonCommand], {
          cwd: process.cwd(),
          detached: true,
          env: environment,
          stderr: "ignore",
          stdin: "ignore",
          stdout: "ignore",
          windowsHide: true,
        }),
      )
      .pipe(
        Effect.flatMap((subprocess) => subprocess.unref),
        Effect.asVoid,
      ),
  ).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (!spawned.success) {
    const note = yield* daemonFailureNote(directory, describeError(spawned.error));
    return yield* Effect.fail(daemonUnavailable(note));
  }

  const locator = yield* waitForDaemon(directory, 100);
  if (locator) {
    return locator;
  }
  const note = yield* daemonFailureNote(
    directory,
    "The daemon did not become ready within five seconds.",
  );
  return yield* Effect.fail(daemonUnavailable(note));
});

export const stopDaemon = Effect.fn("stopDaemon")(function* (
  options: FindDaemonOptions = {},
): Effect.fn.Return<
  StopDaemonStatus,
  Failure,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const directories = resolveStackyardDirectories(
    options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {},
  );
  const locator = yield* findDaemonInDirectory(directories.runtime);
  if (!locator) {
    return "not-running";
  }

  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(
    new URL("api/v1/shutdown", daemonUrl(locator)),
  ).pipe(
    HttpClientRequest.bearerToken(locator.token),
    client.execute,
    Effect.mapError((error) => daemonStopFailure(describeError(error))),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(daemonStopFailure("The shutdown request timed out.")),
    }),
  );
  if (response.status !== 202) {
    return yield* Effect.fail(daemonStopFailure(`The daemon returned HTTP ${response.status}.`));
  }

  const stopped = yield* waitForDaemonStop(directories.runtime, locator, 300).pipe(
    Effect.mapError((error) => daemonStopFailure(describeError(error))),
  );
  if (!stopped) {
    return yield* Effect.fail(
      daemonStopFailure(`Daemon process ${locator.pid} did not stop within fifteen seconds.`),
    );
  }
  return "stopped";
});

const findDaemonInDirectory = Effect.fn("findDaemonInDirectory")(function* (
  directory: string,
): Effect.fn.Return<
  DaemonLocator | undefined,
  Failure,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const current = yield* readLocator(directory).pipe(
    Effect.mapError((error) =>
      daemonUnavailable(`The daemon runtime state could not be inspected: ${describeError(error)}`),
    ),
  );
  if (current && (yield* isReachable(current))) {
    return current;
  }

  const incompatible = current ? undefined : yield* readLocatorProcess(directory);
  if (incompatible && isProcessAlive(incompatible.pid)) {
    return yield* Effect.fail(
      daemonUnavailable(
        `Daemon process ${incompatible.pid} uses protocol ${incompatible.protocolVersion ?? "unknown"}; this CLI requires protocol ${protocolVersion}.`,
      ),
    );
  }

  if (current && isProcessAlive(current.pid)) {
    const note = yield* daemonFailureNote(
      directory,
      `Daemon process ${current.pid} is running but did not answer a health check.`,
    );
    return yield* Effect.fail(daemonUnavailable(note));
  }
  return undefined;
});

export const acquireDaemonLock = Effect.fn("acquireDaemonLock")(function* (
  directory: string,
  instanceId: string,
): Effect.fn.Return<DaemonLock | undefined, Failure, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .makeDirectory(directory, { mode: 0o700, recursive: true })
    .pipe(Effect.mapError(lockFailure));
  return yield* tryAcquireLock(path.join(directory, lockName), instanceId, 100);
});

const tryAcquireLock = Effect.fn("tryAcquireLock")(function* (
  lockDirectory: string,
  instanceId: string,
  attemptsRemaining: number,
): Effect.fn.Return<DaemonLock | undefined, Failure, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const published = yield* publishLockDirectory(lockDirectory, instanceId);
  if (published) {
    return {
      instanceId,
      release: removeOwnedLock(lockDirectory, instanceId).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    };
  }

  const owner = yield* readLockOwner(lockDirectory);
  if (owner && isProcessAlive(owner.pid)) {
    return undefined;
  }
  if (!owner && !(yield* lockExists(lockDirectory))) {
    if (attemptsRemaining <= 1) {
      return yield* Effect.fail(
        lockFailure(new Error("Concurrent daemon lock publication did not converge.")),
      );
    }
    yield* Effect.sleep("25 millis");
    return yield* tryAcquireLock(lockDirectory, instanceId, attemptsRemaining - 1);
  }
  return yield* recoverStaleLock(lockDirectory, instanceId, attemptsRemaining);
});

const recoverStaleLock = Effect.fn("recoverStaleLock")(function* (
  lockDirectory: string,
  instanceId: string,
  attemptsRemaining: number,
): Effect.fn.Return<DaemonLock | undefined, Failure, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const recoveryDirectory = `${lockDirectory}.recovery`;
  const recovery = yield* publishLockDirectory(recoveryDirectory, instanceId);
  if (!recovery) {
    const owner = yield* readLockOwner(recoveryDirectory);
    if (owner && !isProcessAlive(owner.pid)) {
      return yield* Effect.fail(
        lockFailure(new Error(`Stale daemon lock recovery remains at '${recoveryDirectory}'.`)),
      );
    }
    if (attemptsRemaining <= 1) {
      return yield* Effect.fail(
        lockFailure(new Error("Concurrent daemon lock recovery did not converge.")),
      );
    }
    yield* Effect.sleep("25 millis");
    return yield* tryAcquireLock(lockDirectory, instanceId, attemptsRemaining - 1);
  }

  const recovered = yield* Effect.exit(
    Effect.gen(function* () {
      const current = yield* readLockOwner(lockDirectory);
      if (!current) {
        return yield* Effect.fail(
          lockFailure(new Error(`Daemon lock ownership is incomplete at '${lockDirectory}'.`)),
        );
      }
      if (isProcessAlive(current.pid)) {
        return undefined;
      }
      yield* fileSystem
        .remove(lockDirectory, { force: true, recursive: true })
        .pipe(Effect.mapError(lockFailure));
      return yield* tryAcquireLock(lockDirectory, instanceId, 1);
    }),
  );
  const released = yield* removeOwnedLock(recoveryDirectory, instanceId).pipe(
    Effect.mapError(lockFailure),
    Effect.exit,
  );
  if (Exit.isFailure(recovered) && Exit.isFailure(released)) {
    return yield* Effect.failCause(Cause.combine(recovered.cause, released.cause));
  }
  if (Exit.isFailure(recovered)) {
    return yield* Effect.failCause(recovered.cause);
  }
  if (Exit.isFailure(released)) {
    return yield* Effect.failCause(released.cause);
  }
  return recovered.value;
});

const publishLockDirectory = Effect.fn("publishLockDirectory")(function* (
  directory: string,
  instanceId: string,
): Effect.fn.Return<boolean, Failure, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = `${directory}.candidate.${instanceId}`;
  const prepared = yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(candidate);
    const owner: LockOwner = { instanceId, pid: process.pid };
    yield* fileSystem.writeFileString(path.join(candidate, "owner.json"), JSON.stringify(owner), {
      mode: 0o600,
    });
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (!prepared.success) {
    const removed = yield* removePath(candidate);
    return yield* Effect.fail(lockFailure(removed ?? prepared.error));
  }

  const renamed = yield* fileSystem.rename(candidate, directory).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (renamed.success) {
    return true;
  }
  const removed = yield* removePath(candidate);
  if (removed) {
    return yield* Effect.fail(lockFailure(removed));
  }
  return isAlreadyExists(renamed.error) ? false : yield* Effect.fail(lockFailure(renamed.error));
});

const waitForDaemon = Effect.fn("waitForDaemon")(function* (
  directory: string,
  attempts: number,
): Effect.fn.Return<
  DaemonLocator | undefined,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    yield* Effect.sleep("50 millis");
    const locator = yield* readLocator(directory).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (locator && (yield* isReachable(locator))) {
      return locator;
    }
  }
  return undefined;
});

const waitForDaemonStop = Effect.fn("waitForDaemonStop")(function* (
  directory: string,
  locator: DaemonLocator,
  attempts: number,
): Effect.fn.Return<boolean, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = yield* readLocator(directory);
    if ((current && current.instanceId !== locator.instanceId) || !isProcessAlive(locator.pid)) {
      return true;
    }
    yield* Effect.sleep("50 millis");
  }
  return false;
});

export const publishLocator = Effect.fn("publishLocator")(function* (
  directory: string,
  input: Omit<DaemonLocator, "protocolVersion" | "schemaVersion">,
): Effect.fn.Return<
  DaemonLocator,
  AggregateError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const locator = Object.freeze({ ...input, protocolVersion, schemaVersion: version });
  const path = paths.join(directory, locatorName);
  const temporaryPath = paths.join(directory, `${locatorName}.${input.instanceId}.tmp`);
  const published = yield* Effect.gen(function* () {
    yield* fileSystem.writeFileString(temporaryPath, JSON.stringify(locator), { mode: 0o600 });
    yield* fileSystem.rename(temporaryPath, path);
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: () => ({ success: true as const }),
    }),
  );
  if (!published.success) {
    const removed = yield* fileSystem.remove(temporaryPath, { force: true }).pipe(
      Effect.match({
        onFailure: (error) => ({ error, success: false as const }),
        onSuccess: () => ({ success: true as const }),
      }),
    );
    return yield* Effect.fail(
      removed.success
        ? published.error
        : new AggregateError(
            [published.error, removed.error],
            "The daemon locator and its temporary file could not be written.",
          ),
    );
  }
  return locator;
});

export const removeLocator = Effect.fn("removeLocator")(function* (
  directory: string,
  instanceId: string,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* readLocator(directory);
  if (current?.instanceId === instanceId) {
    yield* fileSystem.remove(path.join(directory, locatorName), { force: true });
  }
});

export const readLocator = Effect.fn("readLocator")(function* (
  directory: string,
): Effect.fn.Return<
  DaemonLocator | undefined,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const read = yield* readJson(path.join(directory, locatorName)).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: (value) => ({ success: true as const, value }),
    }),
  );
  if (read.success) {
    const parsed = Schema.decodeUnknownResult(DaemonLocatorSchema, {
      onExcessProperty: "error",
    })(read.value);
    return EffectResult.isSuccess(parsed) ? Object.freeze(parsed.success) : undefined;
  }
  if (read.error instanceof SyntaxError) {
    return undefined;
  }
  if (isMissing(read.error)) {
    return undefined;
  }
  return yield* Effect.fail(read.error);
});

const isReachable = Effect.fn("isReachable")(function* (
  locator: DaemonLocator,
): Effect.fn.Return<boolean, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(new URL("health", daemonUrl(locator))).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json
        : Effect.fail(new Error(`Health check returned HTTP ${response.status}.`)),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(DaemonHealthSchema)),
    Effect.map(({ instanceId }) => instanceId === locator.instanceId),
    Effect.timeoutOption("500 millis"),
    Effect.map(Option.getOrElse(() => false)),
    Effect.catch(() => Effect.succeed(false)),
  );
});

const readLocatorProcess = Effect.fn("readLocatorProcess")(function* (
  directory: string,
): Effect.fn.Return<
  { readonly pid: number; readonly protocolVersion: number | undefined } | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  return yield* readJson(path.join(directory, locatorName)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((value) => {
      const parsed = Schema.decodeUnknownResult(LocatorProcessSchema)(value);
      return EffectResult.isSuccess(parsed)
        ? { pid: parsed.success.pid, protocolVersion: parsed.success.protocolVersion }
        : undefined;
    }),
  );
});

const readLockOwner = Effect.fn("readLockOwner")(function* (lockDirectory: string) {
  const path = yield* Path.Path;
  return yield* readJson(path.join(lockDirectory, "owner.json")).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((value): LockOwner | undefined => {
      const parsed = Schema.decodeUnknownResult(LockOwnerSchema, {
        onExcessProperty: "error",
      })(value);
      return EffectResult.isSuccess(parsed) ? parsed.success : undefined;
    }),
  );
});

const readJson = Effect.fn("readJson")((path: string) =>
  FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readFileString(path).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) =>
            cause instanceof SyntaxError
              ? cause
              : new SyntaxError("Daemon state is not valid JSON.", { cause }),
        }),
      ),
    ),
  ),
);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFileSystemError(error) && error.code === "EPERM";
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function daemonUnavailable(note: string): Failure {
  return failure(
    createDiagnostic({
      code: "SYD3005",
      help: "Stop any stale Stackyard daemon process, then run the command again.",
      message: "The Stackyard daemon is unavailable.",
      notes: [note],
    }),
  );
}

function daemonStopFailure(note: string): Failure {
  return failure(
    createDiagnostic({
      code: "SYD3017",
      help: "Run 'stackyard daemon stop' again. If the problem persists, inspect the daemon diagnostics and stop its process.",
      message: "Stackyard could not be stopped cleanly.",
      notes: [note],
    }),
  );
}

const daemonFailureNote = Effect.fn("daemonFailureNote")(function* (
  directory: string,
  summary: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(directory, diagnosticsName)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((value) => {
      const details = value?.trim();
      return details ? `${summary}\nDaemon diagnostics:\n${details}` : summary;
    }),
  );
});

function lockFailure(error: unknown): Failure {
  return failure(
    createDiagnostic({
      code: "SYD3006",
      help: "Stop any stale Stackyard daemon, remove its lock directories if no daemon is running, then retry.",
      message: "The Stackyard daemon lock could not be acquired.",
      notes: [describeError(error)],
    }),
  );
}

function isAlreadyExists(error: unknown): boolean {
  if (error instanceof PlatformError.PlatformError) {
    if (
      Predicate.isTagged(error.reason, "AlreadyExists") ||
      Predicate.isTagged(error.reason, "Busy") ||
      Predicate.isTagged(error.reason, "PermissionDenied")
    ) {
      return true;
    }
    error = "cause" in error.reason ? error.reason.cause : error;
  }
  if (!isFileSystemError(error)) {
    return false;
  }
  return error.code === "EEXIST" || error.code === "ENOTEMPTY" || error.code === "EPERM";
}

const lockExists = Effect.fn("lockExists")((directory: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.stat(directory)).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        isMissing(error) ? Effect.succeed(false) : Effect.fail(lockFailure(error)),
      onSuccess: () => Effect.succeed(true),
    }),
  ),
);

const removeOwnedLock = Effect.fn("removeOwnedLock")(function* (
  directory: string,
  instanceId: string,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const owner = yield* readLockOwner(directory);
  if (owner?.instanceId === instanceId && owner.pid === process.pid) {
    yield* fileSystem.remove(directory, { force: true, recursive: true });
  }
});

const removePath = Effect.fn("removePath")((path: string) =>
  FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.remove(path, { force: true, recursive: true }),
  ).pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  ),
);

function isMissing(error: unknown): boolean {
  if (error instanceof PlatformError.PlatformError) {
    if (Predicate.isTagged(error.reason, "NotFound")) {
      return true;
    }
    error = "cause" in error.reason ? error.reason.cause : error;
  }
  return isFileSystemError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
