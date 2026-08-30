import { createDiagnostic, type Diagnostic } from "./diagnostic.ts";
import { failure, type Failure } from "./result.ts";

const defaultCapacity = 100;

export interface DiagnosticSink {
  report(diagnostic: Diagnostic): void;
}

export class DiagnosticCollector implements DiagnosticSink {
  readonly #capacity: number;
  readonly #diagnostics: Diagnostic[] = [];
  #omitted = 0;

  constructor(capacity: number = defaultCapacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Diagnostic capacity must be a positive safe integer.");
    }

    this.#capacity = capacity;
  }

  get size(): number {
    return this.#diagnostics.length + this.#omitted;
  }

  clear(): void {
    this.#diagnostics.length = 0;
    this.#omitted = 0;
  }

  report(diagnostic: Diagnostic): void {
    if (this.#diagnostics.length < this.#capacity) {
      this.#diagnostics.push(diagnostic);
      return;
    }

    this.#omitted += 1;
  }

  snapshot(): readonly Diagnostic[] {
    if (this.#omitted === 0) {
      return Object.freeze([...this.#diagnostics]);
    }

    const retained = this.#diagnostics.slice(0, this.#capacity - 1);
    const omitted = this.#omitted + 1;
    retained.push(
      createDiagnostic({
        code: "SYD0000",
        message: `${omitted} additional diagnostics omitted.`,
        severity: "warning",
      }),
    );
    return Object.freeze(retained);
  }

  toFailure(): Failure | undefined {
    const [diagnostic, ...additionalDiagnostics] = this.snapshot();
    return diagnostic ? failure(diagnostic, ...additionalDiagnostics) : undefined;
  }
}

export function reportDiagnostics(sink: DiagnosticSink, diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    sink.report(diagnostic);
  }
}
