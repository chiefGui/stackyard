import { stripVTControlCharacters } from "node:util";

import { createDiagnostic, type DiagnosticSink } from "@stackyard/diagnostics";
import {
  defineCommand,
  renderUsage,
  runCommand,
  type ArgsDef,
  type CommandContext,
  type CommandDef,
  type CommandMeta,
  type SubCommandsDef,
} from "citty";

export interface CliArgumentDiagnostics {
  readonly code: string;
  readonly help: string;
  readonly tooManyPositionals: string;
}

export interface CliCommand {
  readonly definition: SubCommandsDef[string];
  readonly invalidArguments: CliArgumentDiagnostics;
  readonly name: string;
  execute(args: readonly string[]): Promise<number>;
}

export type CliCommandDefinition<T extends ArgsDef> = Omit<
  CommandDef<T>,
  "args" | "meta" | "run"
> & {
  readonly args?: T;
  readonly meta: Omit<CommandMeta, "name">;
  run(context: CommandContext<T>): number | Promise<number>;
};

export interface CliDependencies {
  readonly commands: readonly CliCommand[];
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function defineCliCommand<const T extends ArgsDef>(
  name: string,
  definition: CliCommandDefinition<T>,
  invalidArguments: CliArgumentDiagnostics,
): CliCommand {
  const command = defineCommand({
    ...definition,
    meta: { ...definition.meta, name },
  });
  const validatedCommand = defineCommand({
    ...command,
    async setup(context) {
      const invalidArgument = validateParsedArguments(
        context.args,
        context.rawArgs,
        definition.args ?? {},
        invalidArguments.tooManyPositionals,
      );
      if (invalidArgument) {
        throw new InvalidArgumentsError(invalidArgument);
      }
      await command.setup?.(context);
    },
  });

  return {
    definition: command,
    invalidArguments,
    name,
    async execute(args) {
      const execution = await runCommand(validatedCommand, { rawArgs: [...args] });
      if (typeof execution.result !== "number") {
        throw new TypeError("A CLI command did not return an exit code.");
      }
      return execution.result;
    },
  };
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const [commandName, ...commandArguments] = args;
  if (!commandName || isHelpFlag(commandName)) {
    await writeRootHelp(dependencies);
    return 0;
  }

  if (commandName === "help") {
    return writeRequestedHelp(commandArguments[0], dependencies);
  }

  const command = findCommand(commandName, dependencies.commands);
  if (!command) {
    return reportUnknownCommand(commandName, dependencies);
  }

  if (commandArguments.some(isHelpFlag)) {
    await writeCommandHelp(command, dependencies);
    return 0;
  }

  try {
    return await command.execute(commandArguments);
  } catch (error) {
    if (error instanceof InvalidArgumentsError) {
      reportInvalidArguments(error.message, command, dependencies);
      return 1;
    }
    if (isCittyArgumentError(error)) {
      reportInvalidArguments(stripVTControlCharacters(error.message), command, dependencies);
      return 1;
    }
    throw error;
  }
}

async function writeRequestedHelp(
  commandName: string | undefined,
  dependencies: CliDependencies,
): Promise<number> {
  if (!commandName) {
    await writeRootHelp(dependencies);
    return 0;
  }

  const command = findCommand(commandName, dependencies.commands);
  if (!command) {
    return reportUnknownCommand(commandName, dependencies);
  }

  await writeCommandHelp(command, dependencies);
  return 0;
}

async function writeRootHelp(dependencies: CliDependencies): Promise<void> {
  dependencies.writeOutput(`${await renderUsage(createRootCommand(dependencies.commands))}\n`);
}

async function writeCommandHelp(command: CliCommand, dependencies: CliDependencies): Promise<void> {
  const definition = await resolveCommand(command.definition);
  const root = createRootCommand(dependencies.commands);
  dependencies.writeOutput(`${await renderUsage(definition, root)}\n`);
}

function createRootCommand(commands: CliDependencies["commands"]): CommandDef {
  const subCommands: SubCommandsDef = {};
  for (const command of commands) {
    subCommands[command.name] = command.definition;
  }

  return defineCommand({
    meta: {
      description: "Run and inspect local projects",
      name: "stackyard",
    },
    subCommands,
  });
}

async function resolveCommand(definition: SubCommandsDef[string]) {
  if (typeof definition === "function") {
    return definition();
  }
  return definition;
}

function findCommand(name: string, commands: readonly CliCommand[]): CliCommand | undefined {
  for (const command of commands) {
    if (command.name === name) {
      return command;
    }
  }
  return undefined;
}

function validateParsedArguments(
  args: Readonly<Record<string, boolean | number | string | string[]>> & { readonly _: string[] },
  rawArguments: readonly string[],
  definitions: ArgsDef,
  tooManyPositionals: string,
): string | undefined {
  const knownArguments = new Set(["_", ...Object.keys(definitions)]);
  for (const name of Object.keys(definitions)) {
    knownArguments.add(toCamelCase(name));
    knownArguments.add(toKebabCase(name));
  }
  for (const definition of Object.values(definitions)) {
    if (!("alias" in definition) || !definition.alias) {
      continue;
    }
    if (Array.isArray(definition.alias)) {
      for (const alias of definition.alias) {
        knownArguments.add(alias);
      }
      continue;
    }
    knownArguments.add(definition.alias);
  }

  const unknownArgument = Object.keys(args).find((name) => !knownArguments.has(name));
  if (unknownArgument) {
    return `Unknown option '${findOptionSpelling(unknownArgument, rawArguments)}'.`;
  }

  const positionalLimit = Object.values(definitions).filter(isPositional).length;
  if (args._.length > positionalLimit) {
    return tooManyPositionals;
  }
  return undefined;
}

function toCamelCase(value: string): string {
  return value.replace(/[-_]([a-z])/g, (_match, character: string) => character.toUpperCase());
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function findOptionSpelling(name: string, rawArguments: readonly string[]): string {
  for (const argument of rawArguments) {
    if (argument === "--") {
      break;
    }
    if (!argument.startsWith("-")) {
      continue;
    }

    const [spelling] = argument.split("=", 1);
    if (spelling?.replace(/^--no-/, "").replace(/^-+/, "") === name) {
      return spelling;
    }
  }

  if (name.length === 1) {
    return `-${name}`;
  }
  return `--${name}`;
}

function isPositional(definition: ArgsDef[string]): boolean {
  return definition.type === "positional";
}

function isHelpFlag(argument: string): boolean {
  return argument === "--help" || argument === "-h";
}

function isCittyArgumentError(error: unknown): error is Error & { readonly code: "EARG" } {
  return (
    error instanceof Error && error.name === "CLIError" && "code" in error && error.code === "EARG"
  );
}

function reportUnknownCommand(commandName: string, dependencies: CliDependencies): number {
  dependencies.diagnostics.report(
    createDiagnostic({
      code: "SYD2004",
      help: "Run 'stackyard help' to list the available commands.",
      message: `Unknown command '${commandName}'.`,
    }),
  );
  return 1;
}

function reportInvalidArguments(
  message: string,
  command: CliCommand,
  dependencies: CliDependencies,
): void {
  dependencies.diagnostics.report(
    createDiagnostic({
      code: command.invalidArguments.code,
      help: command.invalidArguments.help,
      message,
    }),
  );
}

class InvalidArgumentsError extends Error {}
