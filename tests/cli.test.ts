import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { parseProjectSpec } from "../packages/protocol/src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

test("inspect discovers and evaluates a project in an isolated process", async () => {
  const result = await runCli(
    ["inspect", "--json"],
    join(repositoryRoot, "examples/basic/stackyard"),
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);

  const parsedSpec = parseProjectSpec(JSON.parse(result.stdout));
  expect(parsedSpec.success).toBeTrue();
  if (!parsedSpec.success) {
    throw new Error("Expected inspect to return a valid project specification.");
  }

  const spec = parsedSpec.output;
  expect(spec.name).toBe("basic");
  expect(spec.schemaVersion).toBe(1);
  expect(Object.keys(spec.resources)).toEqual(["api", "web"]);
});

test("Stackyard describes its own daemon through the public project API", async () => {
  const result = await runCli(["inspect", "--json"], repositoryRoot);

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);

  const parsedSpec = parseProjectSpec(JSON.parse(result.stdout));
  expect(parsedSpec.success).toBeTrue();
  if (!parsedSpec.success) {
    throw new Error("Expected Stackyard's definition to produce a valid project specification.");
  }

  expect(parsedSpec.output.name).toBe("stackyard");
  expect(Object.keys(parsedSpec.output.resources)).toEqual(["daemon", "dashboard"]);

  const daemon = parsedSpec.output.resources.daemon;
  expect(daemon?.command).toEqual({ args: ["run", "dev"], executable: "bun" });
  expect(daemon?.cwd).toBe("apps/daemon");
  expect(daemon?.endpoints.http?.port).toEqual({
    env: "PORT",
    kind: "allocated",
    preferred: 3000,
  });

  const dashboard = parsedSpec.output.resources.dashboard;
  expect(dashboard?.command).toEqual({ args: ["run", "dev"], executable: "bun" });
  expect(dashboard?.cwd).toBe("apps/dashboard-web");
});

test("inspect preserves structured definition errors across the evaluator boundary", async () => {
  const result = await runCli(["inspect"], join(repositoryRoot, "tests/fixtures/invalid-project"));

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("error[SYD1005] at resources.api.cwd");
  expect(result.stderr).toContain("help: Use a forward-slash path inside the project root");
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
