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
        createDiagnostic({
          code: "SYD2003",
          help: "Fix the exception thrown while importing stackyard/main.ts, then retry.",
          message: "Project definition threw while being evaluated.",
          ...(error instanceof Error && error.message.trim().length > 0
            ? { notes: [error.message] }
            : {}),
        }),
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
