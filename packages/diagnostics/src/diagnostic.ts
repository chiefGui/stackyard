export type DiagnosticPath = readonly (number | string)[];
export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: DiagnosticPath;
  readonly severity: DiagnosticSeverity;
}

export interface DiagnosticOptions {
  readonly path?: DiagnosticPath;
  readonly severity?: DiagnosticSeverity;
}

export function createDiagnostic(
  code: string,
  message: string,
  options: DiagnosticOptions = {},
): Diagnostic {
  if (code.length === 0) {
    throw new TypeError("A diagnostic code must not be empty.");
  }

  if (message.length === 0) {
    throw new TypeError("A diagnostic message must not be empty.");
  }

  return Object.freeze({
    code,
    message,
    path: Object.freeze([...(options.path ?? [])]),
    severity: options.severity ?? "error",
  });
}

export function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    "message" in value &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    "path" in value &&
    isDiagnosticPath(value.path) &&
    "severity" in value &&
    (value.severity === "error" || value.severity === "warning")
  );
}

function isDiagnosticPath(value: unknown): value is DiagnosticPath {
  if (!Array.isArray(value)) {
    return false;
  }

  for (const segment of value) {
    if (typeof segment !== "string" && typeof segment !== "number") {
      return false;
    }
  }

  return true;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.path.length === 0 ? "" : ` at ${formatPath(diagnostic.path)}`;
  const severity = diagnostic.severity === "warning" ? "warning " : "";
  return `${severity}${diagnostic.code}${location}: ${diagnostic.message}`;
}

function formatPath(path: DiagnosticPath): string {
  return path.reduce<string>((output, segment) => {
    if (typeof segment === "number") {
      return `${output}[${segment}]`;
    }

    return output.length === 0 ? segment : `${output}.${segment}`;
  }, "");
}
