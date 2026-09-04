import { stripVTControlCharacters } from "node:util";

import {
  createDiagnostic,
  reportDiagnostics,
  type DiagnosticSink,
  type Failure,
} from "@stackyard/diagnostics";
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
import { Effect } from "effect";

const cliName = "stackyard";

export interface CliCommand<R = never> {
  readonly diagnosticCode: string;
  readonly definition: SubCommandsDef[string];
  readonly kind: "command";
  readonly name: string;
  readonly path: string;
  execute(args: readonly string[]): Effect.Effect<number, unknown, R>;
  renderHelp(): Effect.Effect<string>;
}

export interface CliCommandGroup<R = never> {
  readonly commands: readonly CliEntry<R>[];
  readonly definition: SubCommandsDef[string];
  readonly diagnosticCode: string;
  readonly kind: "group";
  readonly name: string;
  readonly path: string;
  renderHelp(): Effect.Effect<string>;
}

export type CliEntry<R = never> = CliCommand<R> | CliCommandGroup<R>;

export type CliCommandDefinition<T extends ArgsDef, R = never> = Omit<
  CommandDef<T>,
  "args" | "meta" | "run"
> & {
  readonly args?: T;
  readonly meta: Omit<CommandMeta, "name">;
  run(context: CommandContext<T>): Effect.Effect<number, never, R>;
};

export interface CliDependencies<R = never> {
  readonly commands: readonly CliEntry<R>[];
  readonly diagnostics: DiagnosticSink;
  readonly version: string;
  writeOutput(output: string): void;
}

export function reportCommandFailure<R>(
  effect: Effect.Effect<number, Failure, R>,
  diagnostics: DiagnosticSink,
): Effect.Effect<number, never, R> {
  return effect.pipe(
    Effect.catch((failed) =>
      Effect.sync(() => {
        reportDiagnostics(diagnostics, failed.diagnostics);
        return 1;
      }),
    ),
  );
}

export function defineCliCommand<const T extends ArgsDef, R = never>(
  name: string,
  diagnosticCode: string,
  definition: CliCommandDefinition<T, R>,
  path = name,
): CliCommand<R> {
  const command = defineCommand({
    ...definition,
    meta: { ...definition.meta, name: `${cliName} ${path}` },
    run: () => 0,
  });

  return {
    diagnosticCode,
    definition: command,
    kind: "command",
    name,
    path,
    execute(args) {
      return Effect.suspend(() => {
        const executionState: { program?: Effect.Effect<number, never, R> } = {};
        const executableCommand = defineCommand({
          ...command,
          run(context) {
            executionState.program = definition.run(context);
            return 0;
          },
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
        return Effect.tryPromise({
          try: () => runCommand(executableCommand, { rawArgs: [...args] }),
          catch: (error) => error,
        }).pipe(
          Effect.flatMap((execution) => {
            const effect = executionState.program;
            return effect && typeof execution.result === "number"
              ? effect
              : Effect.die(new TypeError("A CLI command did not return an exit code."));
          }),
        );
      });
    },
    renderHelp() {
      return Effect.promise(() => renderUsage(command));
    },
  };
}

export function defineCliCommandGroup<R = never>(
  name: string,
  diagnosticCode: string,
  meta: Omit<CommandMeta, "name">,
  commands: readonly CliEntry<R>[],
  path = name,
): CliCommandGroup<R> {
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
    renderHelp: () => Effect.promise(() => renderUsage(command)),
  };
}

export const runCli = Effect.fn("runCli")(function* <R>(
  args: readonly string[],
  dependencies: CliDependencies<R>,
): Effect.fn.Return<number, never, R> {
  const [commandName, ...commandArguments] = args;
  if (commandName && args.length === 1 && isVersionFlag(commandName)) {
    dependencies.writeOutput(`${dependencies.version}\n`);
    return 0;
  }
  if (!commandName) {
    yield* writeRootHelp(dependencies);
    return 0;
  }
  if (commandName === "help" || isHelpFlag(commandName)) {
    yield* writeRootHelp(dependencies);
    return 0;
  }

  const entry = findEntry(commandName, dependencies.commands);
  if (!entry) {
    return reportUnknownCommand(commandName, undefined, dependencies);
  }
  return yield* dispatch(entry, commandArguments, dependencies);
});

const dispatch = Effect.fn("dispatchCliCommand")(function* <R>(
  entry: CliEntry<R>,
  args: readonly string[],
  dependencies: CliDependencies<R>,
): Effect.fn.Return<number, never, R> {
  if (entry.kind === "command") {
    if (args.some(isHelpFlag)) {
      yield* writeEntryHelp(entry, dependencies);
      return 0;
    }
    return yield* executeCommand(entry, args, dependencies);
  }

  const [childName, ...childArguments] = args;
  if (!childName || childName === "help" || isHelpFlag(childName)) {
    yield* writeEntryHelp(entry, dependencies);
    return 0;
  }
  const child = findEntry(childName, entry.commands);
  if (!child) {
    return reportUnknownCommand(childName, entry, dependencies);
  }
  return yield* dispatch(child, childArguments, dependencies);
});

function executeCommand<R>(
  command: CliCommand<R>,
  args: readonly string[],
  dependencies: CliDependencies<R>,
): Effect.Effect<number, never, R> {
  return command.execute(args).pipe(
    Effect.catch((error) => {
      if (error instanceof InvalidArgumentsError) {
        reportInvalidArguments(error.message, command, dependencies);
        return Effect.succeed(1);
      }
      if (isCittyArgumentError(error)) {
        reportInvalidArguments(stripVTControlCharacters(error.message), command, dependencies);
        return Effect.succeed(1);
      }
      return Effect.die(error);
    }),
  );
}

const writeRootHelp = Effect.fn("writeRootHelp")(function* <R>(dependencies: CliDependencies<R>) {
  const usage = yield* Effect.promise(() =>
    renderUsage(createRootCommand(dependencies.commands, dependencies.version)),
  );
  dependencies.writeOutput(`${usage}\n`);
});

const writeEntryHelp = Effect.fn("writeEntryHelp")(function* <R>(
  entry: CliEntry<R>,
  dependencies: CliDependencies<R>,
) {
  dependencies.writeOutput(`${yield* entry.renderHelp()}\n`);
});

function createRootCommand<R>(
  commands: CliDependencies<R>["commands"],
  version: string,
): CommandDef {
  return defineCommand({
    meta: {
      description: "Manage local development projects",
      name: cliName,
      version,
    },
    subCommands: createSubCommands(commands),
  });
}

function createSubCommands<R>(commands: readonly CliEntry<R>[]): SubCommandsDef {
  const subCommands: SubCommandsDef = {};
  for (const entry of commands) {
    subCommands[entry.name] = entry.definition;
  }
  return subCommands;
}

function findEntry<R>(name: string, entries: readonly CliEntry<R>[]): CliEntry<R> | undefined {
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
  parent: CliCommandGroup<unknown> | undefined,
  dependencies: CliDependencies<unknown>,
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
  command: CliCommand<unknown>,
  dependencies: CliDependencies<unknown>,
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
