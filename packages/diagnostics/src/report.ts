import { createDiagnostic, isDiagnostic, type Diagnostic } from "./diagnostic.ts";

const version = 1;

export interface DiagnosticReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly schemaVersion: typeof version;
}

export function createDiagnosticReport(diagnostics: readonly Diagnostic[]): DiagnosticReport {
  const copiedDiagnostics: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (!isDiagnostic(diagnostic)) {
      throw new TypeError("A diagnostic report can contain only valid diagnostics.");
    }

    copiedDiagnostics.push(createDiagnostic(diagnostic));
  }

  return Object.freeze({
    schemaVersion: version,
    diagnostics: Object.freeze(copiedDiagnostics),
  });
}

export function isDiagnosticReport(value: unknown): value is DiagnosticReport {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== version ||
    !("diagnostics" in value) ||
    !Array.isArray(value.diagnostics)
  ) {
    return false;
  }

  for (const diagnostic of value.diagnostics) {
    if (!isDiagnostic(diagnostic)) {
      return false;
    }
  }

  return true;
}

export function parseDiagnosticReport(input: string): DiagnosticReport {
  const value: unknown = JSON.parse(input);
  if (!isDiagnosticReport(value)) {
    throw new TypeError("Input is not a Stackyard diagnostic report.");
  }

  return createDiagnosticReport(value.diagnostics);
}

export function serializeDiagnosticReport(diagnostics: readonly Diagnostic[]): string {
  return JSON.stringify(createDiagnosticReport(diagnostics));
}
