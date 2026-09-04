import {
  reportDiagnostics,
  success,
  type DiagnosticSink,
  type Failure,
} from "@stackyard/diagnostics";
import { Effect } from "effect";

export const superviseCleanup = Effect.fn("superviseCleanup")(function* (
  cleanup: Effect.Effect<void, Failure>,
  diagnostics: DiagnosticSink,
) {
  let delay = 100;
  let reported = false;
  while (true) {
    const result = yield* cleanup.pipe(
      Effect.match({ onFailure: (value) => value, onSuccess: success }),
    );
    if (result.success) {
      return;
    }
    if (!reported) {
      reportDiagnostics(diagnostics, result.diagnostics);
      reported = true;
    }
    yield* Effect.sleep(`${delay} millis`);
    delay = Math.min(delay * 2, 2_000);
  }
});
