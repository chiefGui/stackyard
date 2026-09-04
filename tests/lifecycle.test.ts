import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readLocator as readLocatorEffect } from "../apps/daemon/src/locator.ts";
import { parseProjectList } from "../packages/protocol/src/index.ts";
import { Effect } from "effect";

const repositoryRoot = resolve(import.meta.dir, "..");
const cliEntrypoint = join(repositoryRoot, "apps/cli/src/main.ts");
const projectRoot = join(repositoryRoot, "tests/fixtures/run-project");

test("daemon and project lifecycles stay explicit and idempotent", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-lifecycle-"));
  const runtimeDirectory = join(temporaryRoot, "runtime");
  const environment = {
    ...stringEnvironment(process.env),
    STACKYARD_DATA_DIR: join(temporaryRoot, "data"),
    STACKYARD_RUNTIME_DIR: runtimeDirectory,
  };
  let activeRun: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let daemonPid: number | undefined;
  let foreground: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

  try {
    const bare = await runCli([], temporaryRoot, environment);
    expect(bare.exitCode).toBe(0);
    expect(bare.stderr).toBe("");
    expect(bare.stdout).toContain("USAGE stackyard");
    expect(await readLocator(runtimeDirectory)).toBeUndefined();

    const initiallyStopped = await runCli(["daemon", "status"], temporaryRoot, environment);
    expect(initiallyStopped).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Stackyard is not running.\n",
    });

    const started = await runCli(["daemon", "start"], temporaryRoot, environment);
    expect(started.exitCode).toBe(0);
    expect(started.stderr).toBe("");
    const first = await waitFor(() => readLocator(runtimeDirectory));
    daemonPid = first.pid;
    expect(started.stdout).toBe(`Stackyard is running at http://127.0.0.1:${first.port}/\n`);

    const repeated = await runCli(["daemon", "start"], repositoryRoot, environment);
    expect(repeated).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Stackyard is running at http://127.0.0.1:${first.port}/\n`,
    });
    expect((await readLocator(runtimeDirectory))?.instanceId).toBe(first.instanceId);

    const running = await runCli(["daemon", "status"], temporaryRoot, environment);
    expect(running.stdout).toBe(
      `Stackyard is running at http://127.0.0.1:${first.port}/\nPID: ${first.pid}\n`,
    );
    expect((await readLocator(runtimeDirectory))?.instanceId).toBe(first.instanceId);

    const unrelatedStop = await runCli(["stop"], temporaryRoot, environment);
    expect(unrelatedStop.exitCode).toBe(1);
    expect(unrelatedStop.stderr).toContain("No stackyard/main.ts was found");
    expect((await readLocator(runtimeDirectory))?.instanceId).toBe(first.instanceId);

    const foregroundConflict = await runCli(
      ["daemon", "start", "--foreground"],
      temporaryRoot,
      environment,
    );
    expect(foregroundConflict.exitCode).toBe(1);
    expect(foregroundConflict.stdout).toBe("");
    expect(foregroundConflict.stderr).toContain("Stackyard is already running.");
    expect(foregroundConflict.stderr).toContain("Run 'stackyard daemon stop'");

    const added = await runCli(["add", projectRoot], temporaryRoot, environment);
    expect(added.exitCode).toBe(0);
    activeRun = Bun.spawn({
      cmd: [process.execPath, cliEntrypoint, "run", projectRoot],
      cwd: temporaryRoot,
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
    const runError = new Response(activeRun.stderr).text();
    const runOutput = new Response(activeRun.stdout).text();
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${first.port}/api/v1/projects`);
        const parsed = parseProjectList(await response.json());
        return parsed.success && parsed.output.projects[0]?.state === "running" ? true : undefined;
      } catch {
        return undefined;
      }
    });

    const stopped = await runCli(["stop", projectRoot], temporaryRoot, environment);
    expect(stopped).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Project 'run-fixture' is stopped.\n",
    });
    expect(await activeRun.exited).toBe(0);
    expect(await runError).toBe("");
    expect(await runOutput).toContain("run-fixture is running. Dashboard:");
    expect((await readLocator(runtimeDirectory))?.instanceId).toBe(first.instanceId);

    const repeatedProjectStop = await runCli(["stop"], projectRoot, environment);
    expect(repeatedProjectStop).toEqual(stopped);

    const daemonStopped = await runCli(["daemon", "stop"], temporaryRoot, environment);
    expect(daemonStopped).toEqual({ exitCode: 0, stderr: "", stdout: "Stackyard stopped.\n" });
    await waitFor(async () =>
      (await readLocator(runtimeDirectory)) === undefined && !isProcessAlive(first.pid)
        ? true
        : undefined,
    );
    daemonPid = undefined;

    const repeatedStop = await runCli(["daemon", "stop"], temporaryRoot, environment);
    expect(repeatedStop).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "Stackyard is not running.\n",
    });

    const stoppedWithoutDaemon = await runCli(["stop"], projectRoot, environment);
    expect(stoppedWithoutDaemon).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "No project is running because Stackyard is not running.\n",
    });
    expect(await readLocator(runtimeDirectory)).toBeUndefined();

    foreground = Bun.spawn({
      cmd: [process.execPath, cliEntrypoint, "daemon", "start", "--foreground"],
      cwd: temporaryRoot,
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
    const foregroundError = new Response(foreground.stderr).text();
    const foregroundOutput = new Response(foreground.stdout).text();
    const attached = await waitFor(() => readLocator(runtimeDirectory));
    daemonPid = attached.pid;
    expect(attached.pid).toBe(foreground.pid);

    const reusedForeground = await runCli(["daemon", "start"], repositoryRoot, environment);
    expect(reusedForeground.stdout).toBe(
      `Stackyard is running at http://127.0.0.1:${attached.port}/\n`,
    );
    expect((await readLocator(runtimeDirectory))?.instanceId).toBe(attached.instanceId);

    const stoppedForeground = await runCli(["daemon", "stop"], repositoryRoot, environment);
    expect(stoppedForeground.exitCode).toBe(0);
    expect(await foreground.exited).toBe(0);
    expect(await foregroundError).toBe("");
    expect(await foregroundOutput).toBe(
      `Stackyard is running at http://127.0.0.1:${attached.port}/\nPress Ctrl+C to stop.\n`,
    );
    daemonPid = undefined;
  } finally {
    if (activeRun?.exitCode === null) {
      activeRun.kill("SIGKILL");
      await activeRun.exited;
    }
    if (foreground?.exitCode === null) {
      foreground.kill("SIGKILL");
      await foreground.exited;
    }
    if (daemonPid !== undefined && isProcessAlive(daemonPid)) {
      const pid = daemonPid;
      process.kill(pid, "SIGTERM");
      await waitFor(() => (isProcessAlive(pid) ? undefined : true));
    }
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}, 20_000);

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runCli(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntrypoint, ...args],
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });
  const stderr = new Response(subprocess.stderr).text();
  const stdout = new Response(subprocess.stdout).text();
  return {
    exitCode: await subprocess.exited,
    stderr: await stderr,
    stdout: await stdout,
  };
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  return poll(read, Date.now() + 5_000);
}

async function poll<T>(
  read: () => Promise<T | undefined> | T | undefined,
  deadline: number,
): Promise<T> {
  const value = await read();
  if (value !== undefined) {
    return value;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for Stackyard lifecycle state.");
  }
  await Bun.sleep(25);
  return poll(read, deadline);
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLocator(runtimeDirectory: string) {
  return Effect.runPromise(readLocatorEffect(runtimeDirectory));
}
