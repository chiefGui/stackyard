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
        result: failure(createDiagnostic("TEST", "Expected failure.")),
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
  expect(errors.join("")).toBe("partial output\n[Stackyard truncated project stdout.]\n");
  expect(reportedDiagnostics.map(({ code }) => code)).toEqual(["TEST"]);
});
