import { pathToFileURL } from "node:url";

import { createDiagnostic, failure, isDiagnosticError, type Result } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { readProjectDefinition } from "@stackyard/sdk";

import { createEvaluationMessage, isEvaluationAcknowledgement } from "./evaluation.ts";

export async function runProjectEvaluator(entrypoint: string): Promise<number> {
  let result: Result<ProjectSpec>;

  try {
    const module: unknown = await import(pathToFileURL(entrypoint).href);
    const defaultExport =
      typeof module === "object" && module !== null ? Reflect.get(module, "default") : undefined;
    result = readProjectDefinition(defaultExport);
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

  const { promise: acknowledged, resolve: acknowledge } = Promise.withResolvers<void>();
  const receiveAcknowledgement = (message: unknown): void => {
    if (isEvaluationAcknowledgement(message)) {
      acknowledge();
    }
  };
  process.on("message", receiveAcknowledgement);
  try {
    process.send(createEvaluationMessage(result));
    await acknowledged;
  } finally {
    process.off("message", receiveAcknowledgement);
    process.disconnect?.();
  }
}
