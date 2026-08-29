export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (number | string)[];
}

export interface Failure {
  readonly diagnostics: readonly Diagnostic[];
  readonly success: false;
}

export interface Success<T> {
  readonly output: T;
  readonly success: true;
}

export type Result<T> = Failure | Success<T>;

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.path.length === 0 ? "" : ` at ${formatPath(diagnostic.path)}`;
  return `${diagnostic.code}${location}: ${diagnostic.message}`;
}

function formatPath(path: readonly (number | string)[]): string {
  return path.reduce<string>((output, segment) => {
    if (typeof segment === "number") {
      return `${output}[${segment}]`;
    }

    return output.length === 0 ? segment : `${output}.${segment}`;
  }, "");
}
