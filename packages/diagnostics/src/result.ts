import type { Diagnostic } from "./diagnostic.ts";

export type NonEmptyDiagnostics = readonly [Diagnostic, ...Diagnostic[]];

export interface Failure {
  readonly diagnostics: NonEmptyDiagnostics;
  readonly success: false;
}

export interface Success<T> {
  readonly output: T;
  readonly success: true;
}

export type Result<T> = Failure | Success<T>;

export function failure(
  diagnostic: Diagnostic,
  ...additionalDiagnostics: readonly Diagnostic[]
): Failure {
  const diagnostics: NonEmptyDiagnostics = Object.freeze([diagnostic, ...additionalDiagnostics]);
  return Object.freeze({
    diagnostics,
    success: false,
  });
}

export function success<T>(output: T): Success<T> {
  return Object.freeze({ output, success: true });
}
