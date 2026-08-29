import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");

test("inspect discovers and evaluates a project in an isolated process", async () => {
  const result = await runCli(
    ["inspect", "--json"],
    join(repositoryRoot, "examples/basic/stackyard"),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");

  const spec = JSON.parse(result.stdout) as {
    name: string;
    resources: Record<string, unknown>;
    schemaVersion: number;
  };
  expect(spec.name).toBe("basic");
  expect(spec.schemaVersion).toBe(1);
  expect(Object.keys(spec.resources)).toEqual(["api", "web"]);
});

test("inspect preserves structured definition errors across the evaluator boundary", async () => {
  const result = await runCli(["inspect"], join(repositoryRoot, "tests/fixtures/invalid-project"));

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("SYD1000 at resources.api.cwd");
});

async function runCli(args: readonly string[], cwd: string): Promise<CommandResult> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, join(repositoryRoot, "apps/cli/src/main.ts"), ...args],
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

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}
