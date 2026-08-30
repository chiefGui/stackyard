export type DiagnosticPath = readonly (number | string)[];
export type DiagnosticSeverity = "error" | "warning";

const diagnosticCodePattern = /^SYD\d{4}$/;
const identifierPathSegmentPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface Diagnostic {
  readonly code: string;
  readonly help?: string;
  readonly message: string;
  readonly notes: readonly string[];
  readonly path: DiagnosticPath;
  readonly severity: DiagnosticSeverity;
}

export interface DiagnosticInput {
  readonly code: string;
  readonly help?: string;
  readonly message: string;
  readonly notes?: readonly string[];
  readonly path?: DiagnosticPath;
  readonly severity?: DiagnosticSeverity;
}

export function createDiagnostic(input: DiagnosticInput): Diagnostic {
  if (!diagnosticCodePattern.test(input.code)) {
    throw new TypeError("A diagnostic code must match SYD followed by four digits.");
  }

  if (!isNonEmptyText(input.message)) {
    throw new TypeError("A diagnostic message must not be empty.");
  }

  if (input.help !== undefined && !isNonEmptyText(input.help)) {
    throw new TypeError("Diagnostic help must not be empty when provided.");
  }

  if (input.severity !== undefined && !isDiagnosticSeverity(input.severity)) {
    throw new TypeError("Diagnostic severity must be 'error' or 'warning'.");
  }

  const notes = input.notes ?? [];
  if (!isDiagnosticNotes(notes)) {
    throw new TypeError("Diagnostic notes must contain only non-empty strings.");
  }

  const path = input.path ?? [];
  if (!isDiagnosticPath(path)) {
    throw new TypeError(
      "A diagnostic path must contain only strings or non-negative safe integers.",
    );
  }

  return Object.freeze({
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    path: Object.freeze([...path]),
    ...(input.help === undefined ? {} : { help: input.help }),
    notes: Object.freeze([...notes]),
  });
}

export function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    diagnosticCodePattern.test(value.code) &&
    (!("help" in value) || value.help === undefined || isNonEmptyText(value.help)) &&
    "message" in value &&
    isNonEmptyText(value.message) &&
    "notes" in value &&
    isDiagnosticNotes(value.notes) &&
    "path" in value &&
    isDiagnosticPath(value.path) &&
    "severity" in value &&
    isDiagnosticSeverity(value.severity)
  );
}

function isDiagnosticPath(value: unknown): value is DiagnosticPath {
  if (!Array.isArray(value)) {
    return false;
  }

  for (const segment of value) {
    if (
      typeof segment !== "string" &&
      !(typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0)
    ) {
      return false;
    }
  }

  return true;
}

function isDiagnosticNotes(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) {
    return false;
  }

  for (const note of value) {
    if (!isNonEmptyText(note)) {
      return false;
    }
  }

  return true;
}

function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === "error" || value === "warning";
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.path.length === 0 ? "" : ` at ${formatPath(diagnostic.path)}`;
  const output = [
    `${diagnostic.severity}[${diagnostic.code}]${location}: ${formatContinuation(diagnostic.message, "  ")}`,
  ];

  if (diagnostic.help) {
    output.push(`  help: ${formatContinuation(diagnostic.help, "    ")}`);
  }

  for (const note of diagnostic.notes) {
    output.push(`  note: ${formatContinuation(note, "    ")}`);
  }

  return output.join("\n");
}

function formatContinuation(value: string, indentation: string): string {
  return value.replace(/\r?\n/g, `\n${indentation}`);
}

function formatPath(path: DiagnosticPath): string {
  return path.reduce<string>((output, segment) => {
    if (typeof segment === "number") {
      return `${output}[${segment}]`;
    }

    if (identifierPathSegmentPattern.test(segment)) {
      return output.length === 0 ? segment : `${output}.${segment}`;
    }

    return `${output}[${JSON.stringify(segment)}]`;
  }, "");
}
