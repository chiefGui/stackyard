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
  expect(Object.keys(spec.resources)).toEqual(["web"]);
  expect(spec.resources.web?.command).toEqual({ args: ["service.ts"], executable: "bun" });
  expect(spec.resources.web?.endpoints.http?.port).toEqual({ env: "PORT", kind: "allocated" });
});

test("Stackyard describes its development workflow through the public project API", async () => {
  const result = await runCli(["inspect", "--json"], repositoryRoot);

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);

  const parsedSpec = parseProjectSpec(JSON.parse(result.stdout));
  expect(parsedSpec.success).toBeTrue();
  if (!parsedSpec.success) {
    throw new Error("Expected Stackyard's definition to produce a valid project specification.");
  }

  expect(parsedSpec.output.name).toBe("stackyard");
  expect(Object.keys(parsedSpec.output.resources)).toEqual(["development"]);

  const development = parsedSpec.output.resources.development;
  expect(development?.command).toEqual({ args: ["dev"], executable: "bun" });
  expect(development?.cwd).toBe(".");
  expect(development?.endpoints.api?.port).toEqual({
    env: "STACKYARD_API_PORT",
    kind: "allocated",
    preferred: 3000,
  });
  expect(development?.endpoints.dashboard?.port).toEqual({
    env: "STACKYARD_DASHBOARD_PORT",
    kind: "allocated",
    preferred: 5173,
  });
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
