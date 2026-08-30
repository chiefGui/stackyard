import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(import.meta.dir, "..");
const packageRoot = join(repositoryRoot, "apps/cli");
const fixtureRoot = join(repositoryRoot, "tests/fixtures/package-consumer");

test("the packed package works in an external Bun project", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-package-"));
  const artifactDirectory = join(temporaryRoot, "artifacts");
  const consumerDirectory = join(temporaryRoot, "consumer");

  try {
    await Promise.all([
      mkdir(artifactDirectory),
      cp(fixtureRoot, consumerDirectory, { recursive: true }),
    ]);

    const packed = await runCommand(
      [process.execPath, "pm", "pack", "--destination", artifactDirectory],
      packageRoot,
    );
    expect(packed.exitCode).toBe(0);

    const artifacts = (await readdir(artifactDirectory)).filter((name) => name.endsWith(".tgz"));
    expect(artifacts).toHaveLength(1);

    const artifact = join(artifactDirectory, artifacts[0] ?? "");
    const installed = await runCommand(
      [process.execPath, "add", "--dev", artifact],
      consumerDirectory,
    );
    expect(installed.exitCode).toBe(0);

    const installedPackage = join(consumerDirectory, "node_modules/stackyard");
    const manifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as {
      dependencies?: unknown;
    };
    expect(manifest.dependencies).toBeUndefined();
    expect((await readdir(installedPackage)).sort()).toEqual(["dist", "package.json"]);
    expect((await readdir(join(installedPackage, "dist"))).sort()).toEqual([
      "cli.js",
      "index.d.ts",
      "index.js",
    ]);

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
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const subprocess = Bun.spawn({
    cmd: command,
    cwd,
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
