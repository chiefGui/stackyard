import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type Result,
} from "@stackyard/diagnostics";
import { protocolVersion } from "@stackyard/protocol";

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

export interface DaemonLock {
  readonly instanceId: string;
  release(): Promise<void>;
}

export interface EnsureDaemonOptions {
  readonly dashboardWebDirectory: string;
  readonly daemonEntrypoint: string;
  readonly runtimeDirectory?: string;
}

export function daemonUrl(locator: Pick<DaemonLocator, "port">): string {
  return `http://${daemonHostname}:${locator.port}/`;
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<Result<DaemonLocator>> {
  const directories = resolveStackyardDirectories(
    options.runtimeDirectory ? { runtimeOverride: options.runtimeDirectory } : {},
  );
  const directory = directories.runtime;
  await mkdir(directory, { mode: 0o700, recursive: true });

  const current = await readLocator(directory);
  if (current && (await isReachable(current))) {
    return success(current);
  }

  const incompatible = current ? undefined : await readLocatorProcess(directory);
  if (incompatible && isProcessAlive(incompatible.pid)) {
    return daemonUnavailable(
      `Daemon process ${incompatible.pid} uses protocol ${incompatible.protocolVersion ?? "unknown"}; this CLI requires protocol ${protocolVersion}.`,
    );
  }

  if (current && isProcessAlive(current.pid)) {
    return daemonUnavailable(
      await daemonFailureNote(
        directory,
        `Daemon process ${current.pid} is running but did not answer a health check.`,
      ),
    );
  }

  const diagnosticsPath = join(directory, diagnosticsName);
  try {
    await writeFile(diagnosticsPath, "", { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    return daemonUnavailable(
      `The daemon diagnostic log could not be created: ${describeError(error)}`,
    );
  }
  const environment = stringEnvironment(process.env);
  environment.STACKYARD_DATA_DIR = directories.data;
  environment.STACKYARD_DIAGNOSTICS_PATH = diagnosticsPath;
  environment.STACKYARD_RUNTIME_DIR = directory;
  environment.STACKYARD_DASHBOARD_WEB_DIR = resolve(options.dashboardWebDirectory);

  try {
    const subprocess = Bun.spawn({
      cmd: [process.execPath, options.daemonEntrypoint, internalDaemonCommand],
      detached: true,
      env: environment,
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
      windowsHide: true,
    });
    subprocess.unref();
  } catch (error) {
    return daemonUnavailable(await daemonFailureNote(directory, describeError(error)));
  }

  const locator = await waitForDaemon(directory, Date.now() + 5_000);
  if (locator) {
    return success(locator);
  }

  return daemonUnavailable(
    await daemonFailureNote(directory, "The daemon did not become ready within five seconds."),
  );
}

export async function acquireDaemonLock(
  directory: string,
  instanceId: string,
): Promise<Result<DaemonLock | undefined>> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const lockDirectory = join(directory, lockName);
  return tryAcquireLock(lockDirectory, instanceId, 100);
}

async function tryAcquireLock(
  lockDirectory: string,
  instanceId: string,
  attemptsRemaining: number,
): Promise<Result<DaemonLock | undefined>> {
  const published = await publishLockDirectory(lockDirectory, instanceId);
  if (!published.success) {
    return published;
  }
  if (published.output) {
    return success({
      instanceId,
      async release() {
        const current = await readLockOwner(lockDirectory);
        if (current?.instanceId === instanceId && current.pid === process.pid) {
          await rm(lockDirectory, { force: true, recursive: true });
        }
      },
    });
  }

  const owner = await readLockOwner(lockDirectory);
  if (owner && isProcessAlive(owner.pid)) {
    return success(undefined);
  }
  if (!owner) {
    const present = await lockExists(lockDirectory);
    if (!present.success) {
      return present;
    }
    if (!present.output) {
      if (attemptsRemaining <= 1) {
        return lockFailure(new Error("Concurrent daemon lock publication did not converge."));
      }
      await Bun.sleep(25);
      return tryAcquireLock(lockDirectory, instanceId, attemptsRemaining - 1);
    }
  }

  return recoverStaleLock(lockDirectory, instanceId, attemptsRemaining);
}

async function recoverStaleLock(
  lockDirectory: string,
  instanceId: string,
  attemptsRemaining: number,
): Promise<Result<DaemonLock | undefined>> {
  const recoveryDirectory = `${lockDirectory}.recovery`;
  const recovery = await publishLockDirectory(recoveryDirectory, instanceId);
  if (!recovery.success) {
    return recovery;
  }
  if (!recovery.output) {
    const owner = await readLockOwner(recoveryDirectory);
    if (owner && !isProcessAlive(owner.pid)) {
      return lockFailure(
        new Error(`Stale daemon lock recovery remains at '${recoveryDirectory}'.`),
      );
    }
    if (attemptsRemaining <= 1) {
      return lockFailure(new Error("Concurrent daemon lock recovery did not converge."));
    }
    await Bun.sleep(25);
    return tryAcquireLock(lockDirectory, instanceId, attemptsRemaining - 1);
  }

  try {
    const current = await readLockOwner(lockDirectory);
    if (!current) {
      return lockFailure(new Error(`Daemon lock ownership is incomplete at '${lockDirectory}'.`));
    }
    if (isProcessAlive(current.pid)) {
      return success(undefined);
    }
    await rm(lockDirectory, { force: true, recursive: true });
    return await tryAcquireLock(lockDirectory, instanceId, 1);
  } finally {
    await removeOwnedLock(recoveryDirectory, instanceId);
  }
}

async function publishLockDirectory(
  directory: string,
  instanceId: string,
): Promise<Result<boolean>> {
  const candidate = `${directory}.candidate.${instanceId}`;
  try {
    await mkdir(candidate);
    const owner: LockOwner = { instanceId, pid: process.pid };
    await writeFile(join(candidate, "owner.json"), JSON.stringify(owner), {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    try {
      await rm(candidate, { force: true, recursive: true });
    } catch (cleanupError) {
      return lockFailure(cleanupError);
    }
    return lockFailure(error);
  }

  try {
    await rename(candidate, directory);
    return success(true);
  } catch (error) {
    try {
      await rm(candidate, { force: true, recursive: true });
    } catch (cleanupError) {
      return lockFailure(cleanupError);
    }
    return isAlreadyExists(error) ? success(false) : lockFailure(error);
  }
}

async function waitForDaemon(
  directory: string,
  deadline: number,
): Promise<DaemonLocator | undefined> {
  if (Date.now() >= deadline) {
    return undefined;
  }

  await Bun.sleep(50);
  const locator = await readLocator(directory);
  if (locator && (await isReachable(locator))) {
    return locator;
  }
  return waitForDaemon(directory, deadline);
}

export async function publishLocator(
  directory: string,
  input: Omit<DaemonLocator, "protocolVersion" | "schemaVersion">,
): Promise<DaemonLocator> {
  const locator = Object.freeze({ ...input, protocolVersion, schemaVersion: version });
  const path = join(directory, locatorName);
  const temporaryPath = join(directory, `${locatorName}.${input.instanceId}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(locator), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
  return locator;
}

export async function removeLocator(directory: string, instanceId: string): Promise<void> {
  const current = await readLocator(directory);
  if (current?.instanceId === instanceId) {
    await rm(join(directory, locatorName), { force: true });
  }
}

export async function readLocator(directory: string): Promise<DaemonLocator | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, locatorName), "utf8"));
    return isLocator(value) ? Object.freeze(value) : undefined;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (isFileSystemError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
    ) {
      return undefined;
    }
    throw error;
  }
}

function isLocator(value: unknown): value is DaemonLocator {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "schemaVersion") === version &&
    isNonEmptyString(Reflect.get(value, "instanceId")) &&
    isNonEmptyString(Reflect.get(value, "token")) &&
    isPositiveInteger(Reflect.get(value, "pid")) &&
    isPort(Reflect.get(value, "port")) &&
    Reflect.get(value, "protocolVersion") === protocolVersion
  );
}

async function isReachable(locator: DaemonLocator): Promise<boolean> {
  try {
    const response = await fetch(new URL("health", daemonUrl(locator)), {
      signal: AbortSignal.timeout(500),
    });
    const body: unknown = await response.json();
    return (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      Reflect.get(body, "instanceId") === locator.instanceId &&
      Reflect.get(body, "protocolVersion") === protocolVersion &&
      Reflect.get(body, "status") === "ok"
    );
  } catch {
    return false;
  }
}

async function readLocatorProcess(
  directory: string,
): Promise<{ readonly pid: number; readonly protocolVersion: number | undefined } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, locatorName), "utf8"));
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const pid = Reflect.get(value, "pid");
    const candidateVersion = Reflect.get(value, "protocolVersion");
    return isPositiveInteger(pid)
      ? {
          pid,
          protocolVersion: isPositiveInteger(candidateVersion) ? candidateVersion : undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLockOwner(lockDirectory: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const instanceId = Reflect.get(value, "instanceId");
    const pid = Reflect.get(value, "pid");
    return isNonEmptyString(instanceId) && isPositiveInteger(pid) ? { instanceId, pid } : undefined;
  } catch {
    return undefined;
  }
}

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function daemonUnavailable(note: string): Result<DaemonLocator> {
  return failure(
    createDiagnostic({
      code: "SYD3005",
      help: "Stop any stale Stackyard daemon process, then run the command again.",
      message: "The Stackyard daemon is unavailable.",
      notes: [note],
    }),
  );
}

async function daemonFailureNote(directory: string, summary: string): Promise<string> {
  try {
    const details = (await readFile(join(directory, diagnosticsName), "utf8")).trim();
    return details ? `${summary}\nDaemon diagnostics:\n${details}` : summary;
  } catch {
    return summary;
  }
}

function lockFailure<T = DaemonLock>(error: unknown): Result<T> {
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
  if (!isFileSystemError(error)) {
    return false;
  }
  if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
    return true;
  }
  return error.code === "EPERM";
}

async function lockExists(directory: string): Promise<Result<boolean>> {
  try {
    await stat(directory);
    return success(true);
  } catch (error) {
    return isFileSystemError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
      ? success(false)
      : lockFailure(error);
  }
}

async function removeOwnedLock(directory: string, instanceId: string): Promise<void> {
  const owner = await readLockOwner(directory);
  if (owner?.instanceId === instanceId && owner.pid === process.pid) {
    await rm(directory, { force: true, recursive: true });
  }
}
