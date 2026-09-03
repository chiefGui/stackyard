import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createDiagnostic, failure } from "../packages/diagnostics/src/index.ts";
import {
  makeBunProjectEvaluatorLayer,
  ProjectEvaluationTimeout,
} from "../packages/project-loader/src/bun-project-evaluator.ts";
import {
  evaluateProject,
  ProjectEvaluator,
} from "../packages/project-loader/src/project-evaluator.ts";
import { loadProjectEffect } from "../packages/project-loader/src/load.ts";
import {
  captureProcessOutput,
  emptyCapturedProcessOutput,
} from "../packages/project-loader/src/process-output.ts";

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

test("project loading is independent of the evaluator implementation", async () => {
  const projectRoot = join(repositoryRoot, "tests/fixtures/run-project");
  const evaluator = Layer.succeed(
    ProjectEvaluator,
    ProjectEvaluator.of({
      evaluate: () =>
        Effect.succeed({
          result: failure(
            createDiagnostic({
              code: "SYD2007",
              message: "The supplied project evaluator was used.",
            }),
          ),
          stderr: emptyCapturedProcessOutput(),
          stdout: emptyCapturedProcessOutput(),
        }),
    }),
  );
  const output = await Effect.runPromise(
    loadProjectEffect({
      currentDirectory: projectRoot,
      path: projectRoot,
    }).pipe(Effect.provide(evaluator)),
  );

  expect(output.result.success).toBeFalse();
  if (!output.result.success) {
    expect(output.result.diagnostics[0]?.message).toBe("The supplied project evaluator was used.");
  }
});

test("evaluator infrastructure failures become diagnostics", async () => {
  const output = await runEvaluation({
    entrypoint: "unused-project.ts",
    projectRoot: join(repositoryRoot, "tests/fixtures/project-that-does-not-exist"),
  });

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
  const output = await runEvaluation({
    entrypoint: join(projectRoot, "stackyard/main.ts"),
    projectRoot,
  });

  expect(output.result.success).toBeFalse();
  if (!output.result.success) {
    expect(output.result.diagnostics[0]?.code).toBe("SYD1005");
    expect(Object.isFrozen(output.result)).toBeTrue();
    expect(Object.isFrozen(output.result.diagnostics)).toBeTrue();
    expect(Object.isFrozen(output.result.diagnostics[0])).toBeTrue();
  }
});

test("evaluation timeouts stop the evaluator and become diagnostics", async () => {
  const projectRoot = join(repositoryRoot, "tests/fixtures/run-project");
  const output = await runEvaluation(
    {
      entrypoint: join(projectRoot, "stackyard/main.ts"),
      projectRoot,
    },
    0,
  );

  expect(output.result.success).toBeFalse();
  if (!output.result.success) {
    expect(output.result.diagnostics[0]?.code).toBe("SYD2001");
  }
});

test("evaluator waits until the parent receives its IPC result", async () => {
  const projectRoot = join(repositoryRoot, "tests/fixtures/run-project");
  const evaluated = runEvaluation({
    entrypoint: join(projectRoot, "stackyard/main.ts"),
    projectRoot,
  });

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);

  const output = await evaluated;
  expect(output.result.success).toBeTrue();
});

function runEvaluation(input: Parameters<typeof evaluateProject>[0], timeoutMilliseconds?: number) {
  const evaluation = evaluateProject(input).pipe(
    Effect.provide(makeBunProjectEvaluatorLayer(join(repositoryRoot, "apps/cli/src/main.ts"))),
  );
  return Effect.runPromise(
    timeoutMilliseconds === undefined
      ? evaluation
      : evaluation.pipe(Effect.provideService(ProjectEvaluationTimeout, timeoutMilliseconds)),
  );
}
