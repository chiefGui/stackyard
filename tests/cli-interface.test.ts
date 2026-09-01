import { expect, test } from "bun:test";

import { defineCliCommand, runCli } from "../apps/cli/src/cli.ts";
import { createInspectCommand } from "../apps/cli/src/inspect.ts";
import { createDiagnostic, failure, type Diagnostic } from "../packages/diagnostics/src/index.ts";

test("the CLI dispatches injected commands without knowing their implementation", async () => {
  const receivedValues: string[] = [];
  const reportedDiagnostics: Diagnostic[] = [];
  const output: string[] = [];
  const command = defineCliCommand(
    "custom",
    {
      args: {
        value: { required: true, type: "positional" },
      },
      meta: { description: "A test command" },
      async run({ args }) {
        receivedValues.push(args.value);
        return 7;
      },
    },
    {
      code: "SYD9000",
      help: "Use: stackyard custom <value>",
      tooManyPositionals: "Custom accepts exactly one value.",
    },
  );

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
  expect(receivedValues).toEqual(["value"]);
  expect(reportedDiagnostics).toEqual([]);
  expect(output).toEqual([]);
});

test("the CLI generates help from the command definitions", async () => {
  const output: string[] = [];
  const command = defineCliCommand(
    "custom",
    {
      args: {
        value: { description: "Input value", required: false, type: "positional" },
      },
      meta: { description: "A test command" },
      run() {
        throw new Error("Help must not run the command.");
      },
    },
    {
      code: "SYD9000",
      help: "Use: stackyard custom [value]",
      tooManyPositionals: "Custom accepts at most one value.",
    },
  );

  const exitCode = await runCli(["custom", "--help"], {
    commands: [command],
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(exitCode).toBe(0);
  expect(output.join("\n")).toContain("USAGE stackyard custom");
  expect(output.join("\n")).toContain("Input value");
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

  const exitCode = await runCli(["inspect", "--unknown"], {
    commands: [command],
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    writeOutput() {},
  });

  expect(exitCode).toBe(1);
  expect(reportedDiagnostics).toHaveLength(1);
  expect(reportedDiagnostics[0]?.code).toBe("SYD2005");
  expect(reportedDiagnostics[0]?.message).toBe("Unknown option '--unknown'.");
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

  const exitCode = await runCli(["inspect"], {
    commands: [command],
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    writeOutput() {},
  });

  expect(exitCode).toBe(1);
  expect(errors.join("")).toBe("partial output\n");
  expect(reportedDiagnostics.map(({ code }) => code)).toEqual(["SYD2008", "SYD9000"]);
  expect(reportedDiagnostics[0]?.severity).toBe("warning");
  expect(reportedDiagnostics[0]?.help).toContain("stdout");
});
