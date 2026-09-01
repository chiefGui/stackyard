import { reportDiagnostics, type DiagnosticSink, type Result } from "@stackyard/diagnostics";

/* oxlint-disable eslint/no-await-in-loop -- Cleanup retries are deliberately sequential and back off between attempts. */

export async function superviseCleanup(
  cleanup: () => Promise<Result<void>>,
  diagnostics: DiagnosticSink,
): Promise<void> {
  let delay = 100;
  let reported = false;
  while (true) {
    const result = await cleanup();
    if (result.success) {
      return;
    }
    if (!reported) {
      reportDiagnostics(diagnostics, result.diagnostics);
      reported = true;
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }
}
