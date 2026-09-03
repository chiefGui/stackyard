import {
  createDiagnostic,
  failure,
  isNonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";
import { parseProjectSpec, type ProjectSpec } from "@stackyard/protocol";

const evaluationAcknowledgementType = "stackyard:evaluation-acknowledged";
const evaluationMessageType = "stackyard:evaluation";

export interface EvaluationMessage {
  readonly result: Result<ProjectSpec>;
  readonly type: typeof evaluationMessageType;
}

export function createEvaluationAcknowledgement(): {
  readonly type: typeof evaluationAcknowledgementType;
} {
  return { type: evaluationAcknowledgementType };
}

export function createEvaluationMessage(result: Result<ProjectSpec>): EvaluationMessage {
  return { result, type: evaluationMessageType };
}

export function isEvaluationAcknowledgement(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === evaluationAcknowledgementType
  );
}

export function readEvaluationMessage(value: unknown): EvaluationMessage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (!("type" in value) || value.type !== evaluationMessageType || !("result" in value)) {
    return undefined;
  }

  const result = readEvaluationResult(value.result);
  return result ? { result, type: evaluationMessageType } : undefined;
}

function readEvaluationResult(value: unknown): Result<ProjectSpec> | undefined {
  if (typeof value !== "object" || value === null || !("success" in value)) {
    return undefined;
  }
  if (value.success === true) {
    return "output" in value ? parseProjectSpec(value.output) : undefined;
  }
  if (
    value.success !== false ||
    !("diagnostics" in value) ||
    !isNonEmptyDiagnostics(value.diagnostics)
  ) {
    return undefined;
  }

  const [diagnostic, ...additionalDiagnostics] = value.diagnostics;
  return failure(
    createDiagnostic(diagnostic),
    ...additionalDiagnostics.map((additional) => createDiagnostic(additional)),
  );
}
