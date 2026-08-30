import { describe, expect, test } from "bun:test";

import {
  createDiagnostic,
  createDiagnosticReport,
  DiagnosticCollector,
  DiagnosticError,
  formatDiagnostic,
  isDiagnostic,
  isDiagnosticError,
  isDiagnosticReport,
  isNonEmptyDiagnostics,
  parseDiagnosticReport,
  reportDiagnostics,
  serializeDiagnosticReport,
} from "../packages/diagnostics/src/index.ts";

describe("diagnostics", () => {
  test("creates immutable actionable values", () => {
    const diagnostic = createDiagnostic({
      code: "SYD1000",
      help: "Replace the command with a non-empty executable.",
      message: "Command is invalid.",
      notes: ["The executable was empty."],
      path: ["resources", "api", "command"],
    });

    expect(diagnostic).toEqual({
      code: "SYD1000",
      help: "Replace the command with a non-empty executable.",
      message: "Command is invalid.",
      notes: ["The executable was empty."],
      path: ["resources", "api", "command"],
      severity: "error",
    });
    expect(Object.isFrozen(diagnostic)).toBeTrue();
    expect(Object.isFrozen(diagnostic.notes)).toBeTrue();
    expect(Object.isFrozen(diagnostic.path)).toBeTrue();

    const sparsePath: unknown[] = [];
    sparsePath.length = 1;
    expect(
      isDiagnostic({
        code: "SYD1000",
        message: "Command is invalid.",
        notes: [],
        path: sparsePath,
        severity: "error",
      }),
    ).toBeFalse();
    expect(() =>
      createDiagnostic({ code: "INVALID", message: "Invalid diagnostic code." }),
    ).toThrow("A diagnostic code must match SYD followed by four digits.");
    expect(() =>
      createDiagnostic({ code: "SYD1000", help: " ", message: "Invalid help." }),
    ).toThrow("Diagnostic help must not be empty when provided.");
  });

  test("bounds collected diagnostics and reports truncation", () => {
    const diagnostics = new DiagnosticCollector(2);
    diagnostics.report(createDiagnostic({ code: "SYD9001", message: "First." }));
    diagnostics.report(createDiagnostic({ code: "SYD9002", message: "Second." }));
    diagnostics.report(createDiagnostic({ code: "SYD9003", message: "Third." }));

    expect(diagnostics.size).toBe(3);
    expect(diagnostics.snapshot()).toEqual([
      createDiagnostic({ code: "SYD9001", message: "First." }),
      createDiagnostic({
        code: "SYD0000",
        message: "2 additional diagnostics omitted.",
        severity: "warning",
      }),
    ]);

    diagnostics.clear();
    expect(diagnostics.size).toBe(0);
    expect(diagnostics.snapshot()).toEqual([]);
  });

  test("formats human-readable recovery guidance", () => {
    expect(
      formatDiagnostic(
        createDiagnostic({
          code: "SYD1000",
          help: "Replace the value.\nThen retry.",
          message: "Invalid value.",
          notes: ["Received a number."],
          path: ["resources", "api", "command", "args", 0],
        }),
      ),
    ).toBe(
      "error[SYD1000] at resources.api.command.args[0]: Invalid value.\n" +
        "  help: Replace the value.\n" +
        "    Then retry.\n" +
        "  note: Received a number.",
    );

    expect(
      formatDiagnostic(
        createDiagnostic({
          code: "SYD1000",
          message: "Invalid value.",
          path: ["resources", "worker.api", "env", "API KEY"],
        }),
      ),
    ).toBe('error[SYD1000] at resources["worker.api"].env["API KEY"]: Invalid value.');

    expect(
      formatDiagnostic(
        createDiagnostic({
          code: "SYD0000",
          message: "More omitted.",
          severity: "warning",
        }),
      ),
    ).toBe("warning[SYD0000]: More omitted.");
  });

  test("round-trips a versioned machine-readable report", () => {
    const diagnostic = createDiagnostic({
      code: "SYD9001",
      help: "Fix it.",
      message: "First.",
    });
    const serialized = serializeDiagnosticReport([diagnostic]);

    expect(serialized).toBe(
      '{"schemaVersion":1,"diagnostics":[{"code":"SYD9001","severity":"error","message":"First.","path":[],"help":"Fix it.","notes":[]}]}',
    );

    const report = parseDiagnosticReport(serialized);
    expect(report).toEqual(createDiagnosticReport([diagnostic]));
    expect(isDiagnosticReport(report)).toBeTrue();
    expect(Object.isFrozen(report)).toBeTrue();
    expect(Object.isFrozen(report.diagnostics)).toBeTrue();
    expect(Object.isFrozen(report.diagnostics[0])).toBeTrue();
    expect(isDiagnosticReport({ diagnostics: [], schemaVersion: 2 })).toBeFalse();
  });

  test("sinks consume diagnostics without global state", () => {
    const reported: string[] = [];
    const diagnostics = [
      createDiagnostic({ code: "SYD9001", message: "First." }),
      createDiagnostic({ code: "SYD9002", message: "Second." }),
    ];

    reportDiagnostics(
      {
        report(diagnostic) {
          reported.push(diagnostic.code);
        },
      },
      diagnostics,
    );

    expect(reported).toEqual(["SYD9001", "SYD9002"]);
  });

  test("recognizes errors carrying non-empty diagnostic payloads", () => {
    const error = new DiagnosticError(
      createDiagnostic({ code: "SYD1000", message: "Invalid project." }),
    );
    const sparseDiagnostics: unknown[] = [];
    sparseDiagnostics.length = 1;

    expect(isDiagnosticError(error)).toBeTrue();
    expect(
      isDiagnosticError({
        [Symbol.for("stackyard.diagnostic-error")]: true,
        diagnostics: [],
      }),
    ).toBeFalse();
    expect(
      isDiagnosticError({
        [Symbol.for("stackyard.diagnostic-error.v2")]: true,
        diagnostics: error.diagnostics,
      }),
    ).toBeFalse();
    expect(isNonEmptyDiagnostics(error.diagnostics)).toBeTrue();
    expect(isNonEmptyDiagnostics([])).toBeFalse();
    expect(isNonEmptyDiagnostics(sparseDiagnostics)).toBeFalse();
  });
});
