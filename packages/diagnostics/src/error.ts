import { isDiagnostic, type Diagnostic } from "./diagnostic.ts";
import { failure, type NonEmptyDiagnostics } from "./result.ts";

const diagnosticErrorSymbol = Symbol.for("stackyard.diagnostic-error.v1");

export class DiagnosticError extends Error {
  readonly [diagnosticErrorSymbol] = true;
  readonly diagnostics: NonEmptyDiagnostics;

  constructor(diagnostic: Diagnostic, ...additionalDiagnostics: readonly Diagnostic[]) {
    super(diagnostic.message);
    this.name = "DiagnosticError";
    this.diagnostics = failure(diagnostic, ...additionalDiagnostics).diagnostics;
  }
}

export function isDiagnosticError(error: unknown): error is DiagnosticError {
  const diagnostics =
    typeof error === "object" && error !== null ? Reflect.get(error, "diagnostics") : undefined;

  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, diagnosticErrorSymbol) === true &&
    Array.isArray(diagnostics) &&
    diagnostics.every(isDiagnostic)
  );
}
