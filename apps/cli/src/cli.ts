import { createDiagnostic, type DiagnosticSink } from "@stackyard/diagnostics";

export interface CliCommand {
  readonly description: string;
  readonly name: string;
  readonly usage: string;
  run(args: readonly string[]): Promise<number>;
}

export interface CliDependencies {
  readonly commands: readonly CliCommand[];
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const [commandName, ...commandArgs] = args;

  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    printHelp(dependencies);
    return 0;
  }

  const command = dependencies.commands.find((candidate) => candidate.name === commandName);
  if (!command) {
    dependencies.diagnostics.report(
      createDiagnostic({
        code: "SYD2004",
        help: "Run 'stackyard help' to list the available commands.",
        message: `Unknown command '${commandName}'.`,
      }),
    );
    return 1;
  }

  return command.run(commandArgs);
}

function printHelp(dependencies: CliDependencies): void {
  const commandWidth = dependencies.commands.reduce(
    (width, command) => Math.max(width, command.usage.length),
    0,
  );
  const commands = dependencies.commands
    .map((command) => `  ${command.usage.padEnd(commandWidth)}  ${command.description}`)
    .join("\n");

  dependencies.writeOutput(`Usage: stackyard <command>\n\nCommands:\n${commands}\n`);
}
