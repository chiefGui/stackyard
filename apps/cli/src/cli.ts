import {
  createDiagnostic,
  reportDiagnostics,
  type DiagnosticSink,
  type Failure,
} from "@stackyard/diagnostics";
import { Console, Context, Effect, Layer, Predicate, Result } from "effect";
import { CliConfig, CliError, Command, GlobalFlag } from "effect/unstable/cli";

const cliName = "stackyard";

declare const CliServicesTypeId: unique symbol;

export interface CliCommand<R = never> {
  readonly definition: Command.Command.Any;
  readonly diagnosticCode: string;
  readonly kind: "command";
  readonly name: string;
  readonly path: string;
  readonly positionalLimit: number;
  readonly [CliServicesTypeId]?: R;
}

export interface CliCommandGroup<R = never> {
  readonly commands: readonly CliEntry<R>[];
  readonly definition: Command.Command.Any;
  readonly diagnosticCode: string;
  readonly kind: "group";
  readonly name: string;
  readonly path: string;
  readonly [CliServicesTypeId]?: R;
}

export type CliEntry<R = never> = CliCommand<R> | CliCommandGroup<R>;

export interface CliCommandDefinition<Config extends Command.Command.Config, R = never> {
  readonly args: Config;
  readonly meta: { readonly description: string };
  run(context: {
    readonly args: Command.Command.Config.Infer<Config>;
  }): Effect.Effect<number, never, R>;
  readonly positionalLimit?: number;
}

export interface CliDependencies<R = never> {
  readonly commands: readonly CliEntry<R>[];
  readonly diagnostics: DiagnosticSink;
  readonly version: string;
  writeOutput(output: string): void;
}

class CliExecution extends Context.Service<
  CliExecution,
  {
    readonly exitCode: Effect.Effect<number>;
    readonly setExitCode: (value: number) => Effect.Effect<void>;
  }
>()("stackyard/apps/cli/CliExecution") {}

const CliExecutionLayer = Layer.effect(
  CliExecution,
  Effect.sync(() => {
    let exitCode = 0;
    return CliExecution.of({
      exitCode: Effect.sync(() => exitCode),
      setExitCode: (value: number) =>
        Effect.sync(() => {
          exitCode = value;
        }),
    });
  }),
);

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

export function defineCliCommand<const Config extends Command.Command.Config, R = never>(
  name: string,
  diagnosticCode: string,
  definition: CliCommandDefinition<Config, R>,
  path = name,
): CliCommand<R> {
  const command = Command.make(name, definition.args, (args) =>
    Effect.gen(function* () {
      const execution = yield* CliExecution;
      const exitCode = yield* definition.run({ args });
      yield* execution.setExitCode(exitCode);
    }),
  ).pipe(Command.withDescription(definition.meta.description));

  return {
    definition: command,
    diagnosticCode,
    kind: "command",
    name,
    path,
    positionalLimit: definition.positionalLimit ?? 0,
  };
}

export function defineCliCommandGroup<R = never>(
  name: string,
  diagnosticCode: string,
  meta: { readonly description: string },
  commands: readonly CliEntry<R>[],
  path = name,
): CliCommandGroup<R> {
  const command = Command.make(name).pipe(
    Command.withDescription(meta.description),
    Command.withSubcommands(commands.map(({ definition }) => definition)),
  );
  return { commands, definition: command, diagnosticCode, kind: "group", name, path };
}

export function runCli<R>(
  args: readonly string[],
  dependencies: CliDependencies<R>,
): Effect.Effect<number, never, R | Command.Environment> {
  return Effect.gen(function* () {
    const output: string[] = [];
    const capture: Console.Console = new Proxy(globalThis.console, {
      get(target, property, receiver) {
        if (property === "error" || property === "log") {
          return (...values: readonly unknown[]) =>
            output.push(`${formatConsoleValues(values)}\n`);
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const root = createRootCommand(dependencies.commands);
    const execution = yield* CliExecution;
    // Command.Any intentionally erases heterogeneous handler requirements; CliEntry retains R.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const program = Command.runWith(root, {
      renderErrors: false,
      version: dependencies.version,
    })(normalizeArguments(args, dependencies.commands)) as Effect.Effect<
      void,
      CliError.CliError,
      R | Command.Environment | CliExecution
    >;
    const result = yield* program.pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provideService(CliConfig.CliConfig, {
        builtIns: [GlobalFlag.Help, GlobalFlag.Version],
      }),
      Effect.result,
    );

    if (Result.isFailure(result)) {
      reportCliError(result.failure, dependencies);
      return 1;
    }
    for (const value of output) {
      dependencies.writeOutput(value);
    }
    return yield* execution.exitCode;
  }).pipe(Effect.provide(CliExecutionLayer));
}

function createRootCommand<R>(commands: readonly CliEntry<R>[]): Command.Command.Any {
  return Command.make(cliName).pipe(
    Command.withDescription("Manage local development projects"),
    Command.withSubcommands(commands.map(({ definition }) => definition)),
  );
}

function normalizeArguments<R>(
  args: readonly string[],
  commands: readonly CliEntry<R>[],
): readonly string[] {
  if (args.length === 0 || args[0] === "help") {
    return ["--help"];
  }
  if (args.at(-1) === "help") {
    return [...args.slice(0, -1), "--help"];
  }
  const entry = resolveEntry(args, commands);
  if (entry?.kind === "group") {
    return [...args, "--help"];
  }
  return args;
}

function reportCliError<R>(error: CliError.CliError, dependencies: CliDependencies<R>): void {
  const issue = Predicate.isTagged("ShowHelp")(error) ? error.errors[0] : error;
  if (!issue) {
    return;
  }
  const path = Predicate.isTagged("ShowHelp")(error) ? error.commandPath.slice(1) : [];
  const parent = resolveEntry(path, dependencies.commands);
  const target = parent?.kind === "command" ? parent : undefined;
  const group = parent?.kind === "group" ? parent : undefined;
  const diagnosticCode = target?.diagnosticCode ?? group?.diagnosticCode ?? "SYD2004";
  const commandPath = target?.path ?? group?.path;
  const help = Predicate.isTagged("UnknownSubcommand")(issue)
    ? group
      ? `Run '${cliName} ${group.path} --help' to list the available commands.`
      : "Run 'stackyard help' to list the available commands."
    : commandPath
      ? `Run '${cliName} ${commandPath} --help' to see the accepted arguments.`
      : "Run 'stackyard help' to list the available commands.";
  dependencies.diagnostics.report(
    createDiagnostic({
      code: diagnosticCode,
      help,
      message: cliErrorMessage(issue, target),
    }),
  );
}

function resolveEntry<R>(
  path: readonly string[],
  entries: readonly CliEntry<R>[],
): CliEntry<R> | undefined {
  let candidates = entries;
  let current: CliEntry<R> | undefined;
  for (const name of path) {
    current = candidates.find((entry) => entry.name === name);
    if (!current) {
      return undefined;
    }
    candidates = current.kind === "group" ? current.commands : [];
  }
  return current;
}

function cliErrorMessage(
  error: CliError.NonShowHelpErrors,
  command: CliCommand<unknown> | undefined,
): string {
  if (Predicate.isTagged("UnrecognizedOption")(error)) {
    return `Unknown option '${error.option}'.`;
  }
  if (Predicate.isTagged("UnknownSubcommand")(error)) {
    return `Unknown command '${error.subcommand}'.`;
  }
  if (Predicate.isTagged("UnexpectedArgument")(error) && command) {
    return describePositionalLimit(command.path, command.positionalLimit);
  }
  return error.message;
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

function formatConsoleValues(values: readonly unknown[]): string {
  return values.map(String).join(" ");
}
