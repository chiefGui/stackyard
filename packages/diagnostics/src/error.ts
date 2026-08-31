import type { Diagnostic } from "./diagnostic.ts";
import { failure, isNonEmptyDiagnostics, type NonEmptyDiagnostics } from "./result.ts";

const diagnosticErrorSymbol = Symbol.for("stackyard.diagnostic-error");
const maximumAggregateErrors = 8;
const maximumCauseDepth = 4;
const maximumMessageCharacters = 2_048;
const maximumDescriptionCharacters = 8_192;

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

export function describeError(error: unknown): string {
  return truncate(describe(error, new Set<object>(), 0), maximumDescriptionCharacters);
}

function describe(error: unknown, seen: Set<object>, depth: number): string {
  if (typeof error === "string") {
    return error.trim() ? truncate(error.trim(), maximumMessageCharacters) : unavailable;
  }
  if (!(error instanceof Error)) {
    return unavailable;
  }

  const message = error.message.trim()
    ? truncate(error.message.trim(), maximumMessageCharacters)
    : error.name;
  if (depth >= maximumCauseDepth || seen.has(error)) {
    return message;
  }
  seen.add(error);

  if (error instanceof AggregateError) {
    const causes = error.errors
      .slice(0, maximumAggregateErrors)
      .map((cause, index) => `Cause ${index + 1}: ${describe(cause, seen, depth + 1)}`);
    const omitted = error.errors.length - causes.length;
    if (omitted > 0) {
      causes.push(`${omitted} additional ${omitted === 1 ? "cause" : "causes"} omitted.`);
    }
    return causes.length > 0 ? `${message}\n${causes.join("\n")}` : message;
  }

  return error.cause === undefined
    ? message
    : `${message}\nCause: ${describe(error.cause, seen, depth + 1)}`;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 15)}... [truncated]`;
}

const unavailable = "No details are available.";
