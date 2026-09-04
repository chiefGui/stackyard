import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { readLocator as readLocatorEffect } from "../apps/daemon/src/locator.ts";
import { parseProjectList } from "../packages/protocol/src/index.ts";
import { Effect } from "effect";

const repositoryRoot = resolve(import.meta.dir, "..");
const packageRoot = join(repositoryRoot, "apps/cli");
const fixtureRoot = join(repositoryRoot, "tests/fixtures/package-consumer");

test("the packed package works in an external Bun project", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-package-"));
  const artifactDirectory = join(temporaryRoot, "artifacts");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const dataDirectory = join(temporaryRoot, "data");
  const runtimeDirectory = join(temporaryRoot, "runtime");
  let runProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let daemonPid: number | undefined;

  try {
    await cp(fixtureRoot, consumerDirectory, { recursive: true });

    const artifact = await resolvePackageArtifact(artifactDirectory);
    const installed = await runCommand(
      [process.execPath, "add", "--dev", artifact],
      consumerDirectory,
    );
    expect(installed.exitCode).toBe(0);

    const installedPackage = join(consumerDirectory, "node_modules/stackyard");
    const manifest: unknown = JSON.parse(
      await readFile(join(installedPackage, "package.json"), "utf8"),
    );
    if (typeof manifest !== "object" || manifest === null) {
      throw new TypeError("The installed package manifest must be an object.");
    }
    if (!("version" in manifest) || typeof manifest.version !== "string") {
      throw new TypeError("The installed package manifest must declare a version.");
    }

    expect("dependencies" in manifest).toBeFalse();
    expect((await readdir(installedPackage)).toSorted()).toEqual([
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "dist",
      "package.json",
    ]);
    expect(await readFile(join(installedPackage, "LICENSE"), "utf8")).toBe(
      await readFile(join(repositoryRoot, "LICENSE"), "utf8"),
    );
    expect(await readFile(join(installedPackage, "README.md"), "utf8")).toContain(
      "bun add --global stackyard",
    );
    expect(await readFile(join(installedPackage, "CHANGELOG.md"), "utf8")).toContain("# stackyard");
    expect((await readdir(join(installedPackage, "dist"))).toSorted()).toEqual([
      "cli.js",
      "dashboard-web",
      "index.d.ts",
      "index.js",
    ]);
    expect(
      await readFile(join(installedPackage, "dist/dashboard-web/index.html"), "utf8"),
    ).toContain('<div id="root"></div>');

    const version = await runCommand(
      [process.execPath, "x", "stackyard", "--version"],
      consumerDirectory,
    );
    expect(version).toEqual({ exitCode: 0, stderr: "", stdout: `${manifest.version}\n` });

    const typecheck = await runCommand(
      [process.execPath, "x", "tsc", "--noEmit"],
      consumerDirectory,
    );
    expect(typecheck.exitCode).toBe(0);
    expect(typecheck.stderr).toBe("");

    const valid = await runCommand(
      [process.execPath, "x", "stackyard", "inspect", "projects/valid", "--json"],
      consumerDirectory,
    );
    expect(valid.exitCode).toBe(0);
    expect(valid.stderr).toBe("");
    expect(JSON.parse(valid.stdout)).toEqual({
      name: "package-consumer",
      resources: {
        api: {
          command: {
            args: ["--version"],
            executable: "bun",
          },
          cwd: ".",
          endpoints: {
            http: {
              kind: "http",
              port: {
                env: "PORT",
                kind: "allocated",
              },
            },
          },
          env: {},
          kind: "process",
        },
      },
      schemaVersion: 1,
    });

    const invalid = await runCommand(
      [process.execPath, "x", "stackyard", "inspect", "projects/invalid"],
      consumerDirectory,
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("error[SYD1005] at resources.api.cwd");
    expect(invalid.stderr).toContain("help: Use a forward-slash path inside the project root");

    const runtimeEnvironment = {
      ...stringEnvironment(process.env),
      STACKYARD_DATA_DIR: dataDirectory,
      STACKYARD_RUNTIME_DIR: runtimeDirectory,
    };
    const added = await runCommand(
      [process.execPath, join(installedPackage, "dist/cli.js"), "add", "projects/run"],
      consumerDirectory,
      runtimeEnvironment,
    );
    expect(added.exitCode).toBe(0);
    expect(added.stderr).toBe("");

    const opened = await runCommand(
      [process.execPath, join(installedPackage, "dist/cli.js"), "daemon", "start"],
      consumerDirectory,
      runtimeEnvironment,
    );
    expect(opened.exitCode).toBe(0);
    expect(opened.stderr).toBe("");
    expect(opened.stdout).toMatch(/^Stackyard is running at http:\/\/127\.0\.0\.1:\d+\/\n$/);

    runProcess = Bun.spawn({
      cmd: [process.execPath, join(installedPackage, "dist/cli.js"), "run", "projects/run"],
      cwd: consumerDirectory,
      env: runtimeEnvironment,
      stderr: "pipe",
      stdout: "pipe",
      windowsHide: true,
    });
    const runError = new Response(runProcess.stderr).text();
    const runOutput = new Response(runProcess.stdout).text();
    const locator = await waitFor(() => readLocator(runtimeDirectory));
    daemonPid = locator.pid;
    const projectList = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${locator.port}/api/v1/projects`);
        const parsed = parseProjectList(await response.json());
        return parsed.success &&
          parsed.output.projects.length === 1 &&
          parsed.output.projects[0]?.services[0]?.state === "running" &&
          parsed.output.projects[0].services[0].endpoints.length > 0
          ? parsed.output
          : undefined;
      } catch {
        return undefined;
      }
    });
    expect(projectList.projects[0]?.name).toBe("packed-run");
    const endpoint = projectList.projects[0]?.services[0]?.endpoints[0]?.url;
    expect(
      await waitFor(async () => {
        try {
          const response = await fetch(endpoint ?? "");
          return response.ok ? response.text() : undefined;
        } catch {
          return undefined;
        }
      }),
    ).toBe("packed-fixture");
    expect(
      await fetch(`http://127.0.0.1:${locator.port}/`).then((response) => response.text()),
    ).toContain('<div id="root"></div>');

    runProcess.kill("SIGINT");
    expect(await runProcess.exited).toBe(130);
    expect(await runError).toBe("");
    expect(await runOutput).toContain("packed-run is running. Dashboard:");
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${locator.port}/api/v1/projects`);
        const parsed = parseProjectList(await response.json());
        return parsed.success &&
          parsed.output.projects.length === 1 &&
          parsed.output.projects[0]?.state === "stopped"
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

    const stopped = await runCommand(
      [process.execPath, join(installedPackage, "dist/cli.js"), "daemon", "stop"],
      consumerDirectory,
      runtimeEnvironment,
    );
    expect(stopped).toEqual({ exitCode: 0, stderr: "", stdout: "Stackyard stopped.\n" });
    daemonPid = undefined;
  } finally {
    if (runProcess?.exitCode === null) {
      runProcess.kill("SIGKILL");
    }
    if (daemonPid !== undefined) {
      const pid = daemonPid;
      try {
        process.kill(pid, "SIGTERM");
        await waitFor(async () => (isProcessAlive(pid) ? undefined : true));
      } catch {
        // The daemon may already have completed its idle shutdown.
      }
    }
    await removeTemporaryTree(temporaryRoot);
  }
}, 30_000);

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function resolvePackageArtifact(artifactDirectory: string): Promise<string> {
  const configuredArtifact = process.env.STACKYARD_PACKAGE_TARBALL;
  if (configuredArtifact !== undefined) {
    return resolve(repositoryRoot, configuredArtifact);
  }

  await mkdir(artifactDirectory);
  const packed = await runCommand(
    [process.execPath, "pm", "pack", "--destination", artifactDirectory],
    packageRoot,
  );
  expect(packed.exitCode).toBe(0);

  const artifacts = (await readdir(artifactDirectory)).filter((name) => name.endsWith(".tgz"));
  expect(artifacts).toHaveLength(1);
  return join(artifactDirectory, artifacts[0] ?? "");
}

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  return poll(read, Date.now() + 5_000);
}

async function poll<T>(read: () => Promise<T | undefined>, deadline: number): Promise<T> {
  const value = await read();
  if (value !== undefined) {
    return value;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for the packed Stackyard runtime.");
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

async function removeTemporaryTree(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Windows can release process directory handles asynchronously. */
      await rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      if (!isTransientRemovalFailure(error) || Date.now() >= deadline) {
        throw error;
      }
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Retrying immediately would spin while the handle is held. */
      await Bun.sleep(100);
    }
  }
}

function isTransientRemovalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "ENOTEMPTY" || error.code === "EPERM")
  );
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  const subprocess = Bun.spawn({
    cmd: [...command],
    cwd,
    ...(env ? { env } : {}),
    stderr: "pipe",
    stdout: "pipe",
    windowsHide: true,
  });

  const stderrPromise = new Response(subprocess.stderr).text();
  const stdoutPromise = new Response(subprocess.stdout).text();
  const exitCode = await subprocess.exited;
  const [stderr, stdout] = await Promise.all([stderrPromise, stdoutPromise]);

  return { exitCode, stderr, stdout };
}

function readLocator(runtimeDirectory: string) {
  return Effect.runPromise(readLocatorEffect(runtimeDirectory));
}
