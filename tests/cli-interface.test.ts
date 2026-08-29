import { expect, test } from "bun:test";

import type { Diagnostic } from "../packages/diagnostics/src/index.ts";
import { runCli, type CliCommand } from "../apps/cli/src/cli.ts";

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
