import type { Diagnostic } from "./diagnostic.ts";
import { failure, isNonEmptyDiagnostics, type NonEmptyDiagnostics } from "./result.ts";

const diagnosticErrorSymbol = Symbol.for("stackyard.diagnostic-error");

export class DiagnosticError extends Error {
  readonly diagnostics: NonEmptyDiagnostics;

  constructor(diagnostic: Diagnostic, ...additionalDiagnostics: readonly Diagnostic[]) {
    super(diagnostic.message);
    Object.defineProperty(this, diagnosticErrorSymbol, { value: true });
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
    isNonEmptyDiagnostics(diagnostics)
  );
}
