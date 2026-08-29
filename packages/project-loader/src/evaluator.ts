import { pathToFileURL } from "node:url";

import { createDiagnostic, failure, isDiagnosticError, type Result } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { readProjectDefinition } from "@stackyard/sdk";

import { createEvaluationMessage } from "./evaluation.ts";

export async function runProjectEvaluator(entrypoint: string): Promise<number> {
  let result: Result<ProjectSpec>;

  try {
    const module = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown };
    result = readProjectDefinition(module.default);
  } catch (error) {
    if (isDiagnosticError(error)) {
      const [diagnostic, ...additionalDiagnostics] = error.diagnostics;
      result = failure(diagnostic, ...additionalDiagnostics);
    } else {
      result = failure(
        createDiagnostic(
          "SYD2003",
          error instanceof Error
            ? error.message
            : "Project evaluation failed with an unknown error.",
        ),
      );
    }
  }

  await sendResult(result);
  return result.success ? 0 : 1;
}

async function sendResult(result: Result<ProjectSpec>): Promise<void> {
  if (!process.send) {
    throw new Error("The project evaluator requires an IPC channel.");
  }

  await new Promise<void>((resolve) => {
    process.send?.(createEvaluationMessage(result), () => resolve());
  });
  process.disconnect?.();
}
