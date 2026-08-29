export type {
  Diagnostic,
  DiagnosticOptions,
  DiagnosticPath,
  DiagnosticSeverity,
} from "./diagnostic.ts";
export { createDiagnostic, formatDiagnostic, isDiagnostic } from "./diagnostic.ts";
export { DiagnosticError, isDiagnosticError } from "./error.ts";
export type { Failure, NonEmptyDiagnostics, Result, Success } from "./result.ts";
export { failure, success } from "./result.ts";
export type { DiagnosticSink } from "./sink.ts";
export { DiagnosticCollector, reportDiagnostics } from "./sink.ts";
