import { expect, test } from "bun:test";

import { runCli, type CliCommand } from "../apps/cli/src/cli.ts";
import { createInspectCommand } from "../apps/cli/src/inspect.ts";
import { createDiagnostic, failure, type Diagnostic } from "../packages/diagnostics/src/index.ts";

test("the CLI dispatches injected commands without knowing their implementation", async () => {
  const receivedArguments: string[][] = [];
  const reportedDiagnostics: Diagnostic[] = [];
  const output: string[] = [];
  const command: CliCommand = {
    description: "A test command",
    name: "custom",
    async run(args) {
      receivedArguments.push([...args]);
      return 7;
    },
    usage: "custom [value]",
  };

  const exitCode = await runCli(["custom", "value"], {
    commands: [command],
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(exitCode).toBe(7);
  expect(receivedArguments).toEqual([["value"]]);
  expect(reportedDiagnostics).toEqual([]);
  expect(output).toEqual([]);
});

test("unknown CLI commands report actionable diagnostics", async () => {
  const reportedDiagnostics: Diagnostic[] = [];

  const exitCode = await runCli(["unknown"], {
    commands: [],
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    writeOutput() {},
  });

  expect(exitCode).toBe(1);
  expect(reportedDiagnostics).toHaveLength(1);
  expect(reportedDiagnostics[0]?.code).toBe("SYD2004");
  expect(reportedDiagnostics[0]?.help).toBe("Run 'stackyard help' to list the available commands.");
});

test("invalid inspect arguments report the accepted syntax", async () => {
  const reportedDiagnostics: Diagnostic[] = [];
  const command = createInspectCommand({
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    async loadProject() {
      throw new Error("Invalid arguments must not load a project.");
    },
    writeError() {},
    writeOutput() {},
  });

  expect(await command.run(["--unknown"])).toBe(1);
  expect(reportedDiagnostics).toHaveLength(1);
  expect(reportedDiagnostics[0]?.code).toBe("SYD2005");
  expect(reportedDiagnostics[0]?.help).toBe("Use: stackyard inspect [path] [--json]");
});

test("inspect reports when captured project output was truncated", async () => {
  const errors: string[] = [];
  const reportedDiagnostics: Diagnostic[] = [];
  const command = createInspectCommand({
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    async loadProject() {
      return {
        result: failure(createDiagnostic({ code: "SYD9000", message: "Expected failure." })),
        stderr: { text: "", truncated: false },
        stdout: { text: "partial output", truncated: true },
      };
    },
    writeError(output) {
      errors.push(output);
    },
    writeOutput() {},
  });

  expect(await command.run([])).toBe(1);
  expect(errors.join("")).toBe("partial output\n");
  expect(reportedDiagnostics.map(({ code }) => code)).toEqual(["SYD2008", "SYD9000"]);
  expect(reportedDiagnostics[0]?.severity).toBe("warning");
  expect(reportedDiagnostics[0]?.help).toContain("stdout");
});
