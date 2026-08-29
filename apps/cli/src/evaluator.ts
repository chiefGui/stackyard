import { pathToFileURL } from "node:url";

import { type ProjectSpec, type Result } from "@stackyard/protocol";
import { isProjectDefinitionError, readProjectDefinition } from "@stackyard/sdk";

import { createEvaluationMessage } from "./evaluation.ts";

export async function runEvaluator(entrypoint: string): Promise<number> {
  let result: Result<ProjectSpec>;

  try {
    const module = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown };
    result = readProjectDefinition(module.default);
  } catch (error) {
    result = {
      diagnostics: isProjectDefinitionError(error)
        ? error.diagnostics
        : [
            {
              code: "SYD2003",
              message:
                error instanceof Error
                  ? error.message
                  : "Project evaluation failed with an unknown error.",
              path: [],
            },
          ],
      success: false,
    };
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
