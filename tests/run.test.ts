import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readLocator } from "../apps/daemon/src/locator.ts";
import { parseRuntimeSnapshot } from "../packages/protocol/src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const projectRoot = join(repositoryRoot, "tests/fixtures/run-project");
const secondProjectRoot = join(repositoryRoot, "tests/fixtures/run-project-two");

test("run owns a real project through the global daemon", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "stackyard-run-"));
  let cli: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let secondCli: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let daemonPid: number | undefined;

  try {
    const dashboardBuild = Bun.spawn({
      cmd: [process.execPath, "run", "--filter", "@stackyard/dashboard-web", "build"],
      cwd: repositoryRoot,
      stderr: "ignore",
      stdout: "ignore",
      windowsHide: true,
    });
    expect(await dashboardBuild.exited).toBe(0);

    cli = Bun.spawn({
      cmd: [process.execPath, join(repositoryRoot, "apps/cli/src/main.ts"), "run", projectRoot],
      cwd: repositoryRoot,
      env: {
        ...stringEnvironment(process.env),
        RUN_FIXTURE_VALUE: "first-run",
        STACKYARD_RUNTIME_DIR: runtimeRoot,
      },
      stderr: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
    const stderr = new Response(cli.stderr).text();
    const stdout = new Response(cli.stdout).text();

    const locator = await waitFor(() => readLocator(runtimeRoot));
    daemonPid = locator.pid;

    const snapshot = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${locator.port}/api/v1/snapshot`);
        const parsed = parseRuntimeSnapshot(await response.json());
        const resource = parsed.success ? parsed.output.projects[0]?.resources[0] : undefined;
        return resource?.state === "running" && resource.endpoints.length > 0
          ? parsed.output
          : undefined;
      } catch {
        return undefined;
      }
    });
    expect(snapshot.projects[0]?.name).toBe("run-fixture");
    expect(snapshot.projects[0]?.resources[0]?.state).toBe("running");

    const endpoint = snapshot.projects[0]?.resources[0]?.endpoints[0]?.url;
    expect(endpoint).toBeString();
    expect(
      await waitFor(async () => {
        try {
          const response = await fetch(endpoint ?? "");
          return response.ok ? response.text() : undefined;
        } catch {
          return undefined;
        }
      }),
    ).toBe("fixture");
    expect(await fetch(`${endpoint}/environment`).then((response) => response.json())).toEqual({
      processStart: null,
      runtimeDirectory: null,
      value: "first-run",
    });
    expect(
      await fetch(`http://127.0.0.1:${locator.port}/`).then((response) => response.status),
    ).toBe(200);

    secondCli = Bun.spawn({
      cmd: [
        process.execPath,
        join(repositoryRoot, "apps/cli/src/main.ts"),
        "run",
        secondProjectRoot,
      ],
      cwd: repositoryRoot,
      env: {
        ...stringEnvironment(process.env),
        RUN_FIXTURE_VALUE: "second-run",
        STACKYARD_RUNTIME_DIR: runtimeRoot,
      },
      stderr: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
    const secondStderr = new Response(secondCli.stderr).text();
    const secondStdout = new Response(secondCli.stdout).text();

    const sharedLocator = await waitFor(() => readLocator(runtimeRoot));
    expect(sharedLocator.instanceId).toBe(locator.instanceId);
    const sharedSnapshot = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${locator.port}/api/v1/snapshot`);
        const parsed = parseRuntimeSnapshot(await response.json());
        return parsed.success && parsed.output.projects.length === 2 ? parsed.output : undefined;
      } catch {
        return undefined;
      }
    });
    const secondEndpoint = sharedSnapshot.projects.find(({ name }) => name === "run-fixture-two")
      ?.resources[0]?.endpoints[0]?.url;
    expect(secondEndpoint).toBeString();
    expect(secondEndpoint).not.toBe(endpoint);
    expect(
      await waitFor(async () => {
        try {
          const response = await fetch(secondEndpoint ?? "");
          return response.ok ? response.text() : undefined;
        } catch {
          return undefined;
        }
      }),
    ).toBe("fixture-two");
    expect(
      await fetch(`${secondEndpoint}/environment`).then((response) => response.json()),
    ).toEqual({ processStart: null, runtimeDirectory: null, value: "second-run" });

    cli.kill("SIGINT");
    expect(await cli.exited).toBe(process.platform === "win32" ? 130 : 0);
    expect(await stderr).toBe("");
    expect(await stdout).toContain("run-fixture is running. Dashboard:");

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${locator.port}/api/v1/snapshot`);
        const parsed = parseRuntimeSnapshot(await response.json());
        return parsed.success &&
          parsed.output.projects.length === 1 &&
          parsed.output.projects[0]?.name === "run-fixture-two"
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    });
    await waitFor(async () => {
      try {
        await fetch(endpoint ?? "");
        return undefined;
      } catch {
        return true;
      }
    });
    expect(await fetch(secondEndpoint ?? "").then((response) => response.text())).toBe(
      "fixture-two",
    );

    secondCli.kill("SIGINT");
    expect(await secondCli.exited).toBe(process.platform === "win32" ? 130 : 0);
    expect(await secondStderr).toBe("");
    expect(await secondStdout).toContain("run-fixture-two is running. Dashboard:");
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${locator.port}/api/v1/snapshot`);
        const parsed = parseRuntimeSnapshot(await response.json());
        return parsed.success && parsed.output.projects.length === 0 ? true : undefined;
      } catch {
        return undefined;
      }
    });
    await waitFor(async () => {
      try {
        await fetch(secondEndpoint ?? "");
        return undefined;
      } catch {
        return true;
      }
    });
  } finally {
    if (cli?.exitCode === null) {
      cli.kill("SIGKILL");
    }
    if (secondCli?.exitCode === null) {
      secondCli.kill("SIGKILL");
    }
    if (daemonPid !== undefined) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // The daemon may already have completed its idle shutdown.
      }
    }
    await rm(runtimeRoot, { force: true, recursive: true });
  }
}, 15_000);

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  return poll(read, Date.now() + 5_000);
}

async function poll<T>(read: () => Promise<T | undefined>, deadline: number): Promise<T> {
  const value = await read();
  if (value !== undefined) {
    return value;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for Stackyard runtime state.");
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
