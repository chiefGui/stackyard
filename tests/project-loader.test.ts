import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { evaluateProject } from "../packages/project-loader/src/evaluation.ts";
import { captureProcessOutput } from "../packages/project-loader/src/process-output.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

test("process output is drained while retained output stays bounded", async () => {
  const encoder = new TextEncoder();
  const output = await captureProcessOutput(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("abc"));
        controller.enqueue(encoder.encode("def"));
        controller.close();
      },
    }),
    5,
  );

  expect(output).toEqual({ text: "abcde", truncated: true });
  expect(Object.isFrozen(output)).toBeTrue();
});

test("evaluator infrastructure failures become diagnostics", async () => {
  const output = await evaluateProject(
    "unused-evaluator.ts",
    "unused-project.ts",
    join(repositoryRoot, "tests/fixtures/project-that-does-not-exist"),
  );

  expect(output.result.success).toBeFalse();
  if (!output.result.success) {
    expect(output.result.diagnostics[0]?.code).toBe("SYD2007");
    expect(output.result.diagnostics[0]?.help).toContain("Retry");
    expect(output.result.diagnostics[0]?.notes).not.toEqual([]);
  }
  expect(output.stderr).toEqual({ text: "", truncated: false });
  expect(output.stdout).toEqual({ text: "", truncated: false });
});

test("evaluator failures are normalized at the IPC boundary", async () => {
  const projectRoot = join(repositoryRoot, "tests/fixtures/invalid-project");
  const output = await evaluateProject(
    join(repositoryRoot, "apps/cli/src/main.ts"),
    join(projectRoot, "stackyard/main.ts"),
    projectRoot,
  );

  expect(output.result.success).toBeFalse();
  if (!output.result.success) {
    expect(output.result.diagnostics[0]?.code).toBe("SYD1005");
    expect(Object.isFrozen(output.result)).toBeTrue();
    expect(Object.isFrozen(output.result.diagnostics)).toBeTrue();
    expect(Object.isFrozen(output.result.diagnostics[0])).toBeTrue();
  }
});
