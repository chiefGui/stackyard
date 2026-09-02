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

const cliName = "stackyard";

export interface CliCommand {
  readonly diagnosticCode: string;
  readonly definition: SubCommandsDef[string];
  readonly kind: "command";
  readonly name: string;
  readonly path: string;
  execute(args: readonly string[]): Promise<number>;
  renderHelp(): Promise<string>;
}

export interface CliCommandGroup {
  readonly commands: readonly CliEntry[];
  readonly definition: SubCommandsDef[string];
  readonly diagnosticCode: string;
  readonly kind: "group";
  readonly name: string;
  readonly path: string;
  renderHelp(): Promise<string>;
}

export type CliEntry = CliCommand | CliCommandGroup;

export type CliCommandDefinition<T extends ArgsDef> = Omit<
  CommandDef<T>,
  "args" | "meta" | "run"
> & {
  readonly args?: T;
  readonly meta: Omit<CommandMeta, "name">;
  run(context: CommandContext<T>): number | Promise<number>;
};

export interface CliDependencies {
  readonly commands: readonly CliEntry[];
  readonly diagnostics: DiagnosticSink;
  readonly version: string;
  writeOutput(output: string): void;
}

export function defineCliCommand<const T extends ArgsDef>(
  name: string,
  diagnosticCode: string,
  definition: CliCommandDefinition<T>,
  path = name,
): CliCommand {
  const command = defineCommand({
    ...definition,
    meta: { ...definition.meta, name: `${cliName} ${path}` },
  });
  const validatedCommand = defineCommand({
    ...command,
    async setup(context) {
      const invalidArgument = validateParsedArguments(
        context.args,
        context.rawArgs,
        definition.args ?? {},
        path,
      );
      if (invalidArgument) {
        throw new InvalidArgumentsError(invalidArgument);
      }
      await command.setup?.(context);
    },
  });

  return {
    diagnosticCode,
    definition: command,
    kind: "command",
    name,
    path,
    async execute(args) {
      const execution = await runCommand(validatedCommand, { rawArgs: [...args] });
      if (typeof execution.result !== "number") {
        throw new TypeError("A CLI command did not return an exit code.");
      }
      return execution.result;
    },
    renderHelp() {
      return renderUsage(command);
    },
  };
}

export function defineCliCommandGroup(
  name: string,
  diagnosticCode: string,
  meta: Omit<CommandMeta, "name">,
  commands: readonly CliEntry[],
  path = name,
): CliCommandGroup {
  const command = defineCommand({
    meta: { ...meta, name: `${cliName} ${path}` },
    subCommands: createSubCommands(commands),
  });
  return {
    commands,
    definition: command,
    diagnosticCode,
    kind: "group",
    name,
    path,
    renderHelp: () => renderUsage(command),
  };
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const [commandName, ...commandArguments] = args;
  if (commandName && args.length === 1 && isVersionFlag(commandName)) {
    dependencies.writeOutput(`${dependencies.version}\n`);
    return 0;
  }
  if (!commandName) {
    await writeRootHelp(dependencies);
    return 0;
  }
  if (commandName === "help" || isHelpFlag(commandName)) {
    await writeRootHelp(dependencies);
    return 0;
  }

  const entry = findEntry(commandName, dependencies.commands);
  if (!entry) {
    return reportUnknownCommand(commandName, undefined, dependencies);
  }
  return dispatch(entry, commandArguments, dependencies);
}

async function dispatch(
  entry: CliEntry,
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (entry.kind === "command") {
    if (args.some(isHelpFlag)) {
      await writeEntryHelp(entry, dependencies);
      return 0;
    }
    return executeCommand(entry, args, dependencies);
  }

  const [childName, ...childArguments] = args;
  if (!childName || childName === "help" || isHelpFlag(childName)) {
    await writeEntryHelp(entry, dependencies);
    return 0;
  }
  const child = findEntry(childName, entry.commands);
  if (!child) {
    return reportUnknownCommand(childName, entry, dependencies);
  }
  return dispatch(child, childArguments, dependencies);
}

async function executeCommand(
  command: CliCommand,
  args: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  try {
    return await command.execute(args);
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

async function writeRootHelp(dependencies: CliDependencies): Promise<void> {
  dependencies.writeOutput(
    `${await renderUsage(createRootCommand(dependencies.commands, dependencies.version))}\n`,
  );
}

async function writeEntryHelp(entry: CliEntry, dependencies: CliDependencies): Promise<void> {
  dependencies.writeOutput(`${await entry.renderHelp()}\n`);
}

function createRootCommand(commands: CliDependencies["commands"], version: string): CommandDef {
  return defineCommand({
    meta: {
      description: "Manage local development projects",
      name: cliName,
      version,
    },
    subCommands: createSubCommands(commands),
  });
}

function createSubCommands(commands: readonly CliEntry[]): SubCommandsDef {
  const subCommands: SubCommandsDef = {};
  for (const entry of commands) {
    subCommands[entry.name] = entry.definition;
  }
  return subCommands;
}

function findEntry(name: string, entries: readonly CliEntry[]): CliEntry | undefined {
  for (const entry of entries) {
    if (entry.name === name) {
      return entry;
    }
  }
  return undefined;
}

function validateParsedArguments(
  args: Readonly<Record<string, boolean | number | string | string[]>> & { readonly _: string[] },
  rawArguments: readonly string[],
  definitions: ArgsDef,
  commandName: string,
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
    return describePositionalLimit(commandName, positionalLimit);
  }
  return undefined;
}

function describePositionalLimit(commandName: string, limit: number): string {
  if (limit === 0) {
    return `Command '${commandName}' does not accept positional arguments.`;
  }
  if (limit === 1) {
    return `Command '${commandName}' accepts at most one positional argument.`;
  }
  return `Command '${commandName}' accepts at most ${limit} positional arguments.`;
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

function isVersionFlag(argument: string): boolean {
  return argument === "--version" || argument === "-v";
}

function isCittyArgumentError(error: unknown): error is Error & { readonly code: "EARG" } {
  return (
    error instanceof Error && error.name === "CLIError" && "code" in error && error.code === "EARG"
  );
}

function reportUnknownCommand(
  commandName: string,
  parent: CliCommandGroup | undefined,
  dependencies: CliDependencies,
): number {
  dependencies.diagnostics.report(
    createDiagnostic({
      code: parent?.diagnosticCode ?? "SYD2004",
      help: parent
        ? `Run '${cliName} ${parent.path} --help' to list the available commands.`
        : "Run 'stackyard help' to list the available commands.",
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
      code: command.diagnosticCode,
      help: `Run '${cliName} ${command.path} --help' to see the accepted arguments.`,
      message,
    }),
  );
}

class InvalidArgumentsError extends Error {}
