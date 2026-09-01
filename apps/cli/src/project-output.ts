import { createDiagnostic, type DiagnosticSink } from "@stackyard/diagnostics";
import type { CapturedProcessOutput, ProjectLoadOutcome } from "@stackyard/project-loader";

export interface ProjectOutputDependencies {
  readonly diagnostics: DiagnosticSink;
  writeError(output: string): void;
}

export function writeProjectEvaluationOutput(
  project: Pick<ProjectLoadOutcome, "stderr" | "stdout">,
  dependencies: ProjectOutputDependencies,
): void {
  writeCapturedOutput(project.stdout, "stdout", dependencies);
  writeCapturedOutput(project.stderr, "stderr", dependencies);
}

function writeCapturedOutput(
  output: CapturedProcessOutput,
  name: "stderr" | "stdout",
  dependencies: ProjectOutputDependencies,
): void {
  if (output.text.length > 0) {
    dependencies.writeError(output.text);
  }

  if (!output.truncated) {
    return;
  }

  if (output.text.length > 0 && !output.text.endsWith("\n")) {
    dependencies.writeError("\n");
  }

  dependencies.diagnostics.report(
    createDiagnostic({
      code: "SYD2008",
      help: `Reduce output written to ${name} while evaluating stackyard/main.ts.`,
      message: `Project ${name} was truncated.`,
      severity: "warning",
    }),
  );
}
