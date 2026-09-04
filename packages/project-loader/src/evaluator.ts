import { pathToFileURL } from "node:url";

import { createDiagnostic, failure, isDiagnosticError, type Result } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";
import { readProjectDefinition } from "@stackyard/sdk";
import { Effect } from "effect";

import { createEvaluationMessage, isEvaluationAcknowledgement } from "./evaluation-protocol.ts";

export const runProjectEvaluator = Effect.fn("runProjectEvaluator")(function* (entrypoint: string) {
  const result = yield* Effect.tryPromise({
    try: async () => {
      const module: unknown = await import(pathToFileURL(entrypoint).href);
      const defaultExport =
        typeof module === "object" && module !== null ? Reflect.get(module, "default") : undefined;
      return readProjectDefinition(defaultExport);
    },
    catch: evaluationFailure,
  }).pipe(
    Effect.match({
      onFailure: (failed) => failed,
      onSuccess: (evaluated) => evaluated,
    }),
  );
  yield* sendResult(result);
  return result.success ? 0 : 1;
});

const sendResult = Effect.fn("sendEvaluationResult")(
  (result: Result<ProjectSpec>): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      if (!process.send) {
        resume(Effect.die(new Error("The project evaluator requires an IPC channel.")));
        return Effect.void;
      }
      const cleanup = (): void => {
        process.off("message", receiveAcknowledgement);
        process.disconnect?.();
      };
      const receiveAcknowledgement = (message: unknown): void => {
        if (isEvaluationAcknowledgement(message)) {
          cleanup();
          resume(Effect.void);
        }
      };
      process.on("message", receiveAcknowledgement);
      try {
        process.send(createEvaluationMessage(result));
      } catch (error) {
        cleanup();
        resume(Effect.die(error));
      }
      return Effect.sync(cleanup);
    }),
);

function evaluationFailure(error: unknown) {
  if (isDiagnosticError(error)) {
    const [diagnostic, ...additionalDiagnostics] = error.diagnostics;
    return failure(diagnostic, ...additionalDiagnostics);
  }
  return failure(
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
