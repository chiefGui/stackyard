import { describe, expect, test } from "bun:test";

import {
  createDiagnostic,
  DiagnosticCollector,
  DiagnosticError,
  formatDiagnostic,
  isDiagnosticError,
  reportDiagnostics,
} from "../packages/diagnostics/src/index.ts";

describe("diagnostics", () => {
  test("creates immutable serializable values", () => {
    const diagnostic = createDiagnostic("SYD1000", "Invalid command.", {
      path: ["resources", "api", "command"],
    });

    expect(diagnostic).toEqual({
      code: "SYD1000",
      message: "Invalid command.",
      path: ["resources", "api", "command"],
      severity: "error",
    });
    expect(Object.isFrozen(diagnostic)).toBeTrue();
    expect(Object.isFrozen(diagnostic.path)).toBeTrue();
  });

  test("bounds collected diagnostics and reports truncation", () => {
    const diagnostics = new DiagnosticCollector(2);
    diagnostics.report(createDiagnostic("ONE", "First."));
    diagnostics.report(createDiagnostic("TWO", "Second."));
    diagnostics.report(createDiagnostic("THREE", "Third."));

    expect(diagnostics.size).toBe(3);
    expect(diagnostics.snapshot()).toEqual([
      createDiagnostic("ONE", "First."),
      createDiagnostic("SYD0000", "2 additional diagnostics omitted.", {
        severity: "warning",
      }),
    ]);

    diagnostics.clear();
    expect(diagnostics.size).toBe(0);
    expect(diagnostics.snapshot()).toEqual([]);
  });

  test("formats paths and warning severity", () => {
    expect(
      formatDiagnostic(
        createDiagnostic("SYD1000", "Invalid value.", {
          path: ["resources", "api", "command", "args", 0],
        }),
      ),
    ).toBe("SYD1000 at resources.api.command.args[0]: Invalid value.");

    expect(
      formatDiagnostic(createDiagnostic("SYD0000", "More omitted.", { severity: "warning" })),
    ).toBe("warning SYD0000: More omitted.");
  });

  test("sinks can consume diagnostics without global state", () => {
    const reported: string[] = [];
    const diagnostics = [createDiagnostic("ONE", "First."), createDiagnostic("TWO", "Second.")];

    reportDiagnostics(
      {
        report(diagnostic) {
          reported.push(diagnostic.code);
        },
      },
      diagnostics,
    );

    expect(reported).toEqual(["ONE", "TWO"]);
  });

  test("recognizes errors carrying diagnostic payloads", () => {
    const error = new DiagnosticError(createDiagnostic("SYD1000", "Invalid project."));

    expect(isDiagnosticError(error)).toBeTrue();
  });
});
