import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Argument } from "effect/unstable/cli";
import { createAddCommand } from "../apps/cli/src/add.ts";
import {
  defineCliCommand,
  runCli as runCliEffect,
  type CliCommand,
  type CliDependencies,
} from "../apps/cli/src/cli.ts";
import { createDaemonStatusCommand } from "../apps/cli/src/daemon-status.ts";
import { createDaemonStopCommand } from "../apps/cli/src/daemon-stop.ts";
import { createDaemonCommand } from "../apps/cli/src/daemon.ts";
import { createInspectCommand } from "../apps/cli/src/inspect.ts";
import { createListCommand } from "../apps/cli/src/list.ts";
import { ProjectClient } from "../apps/cli/src/project-client.ts";
import { createRemoveCommand } from "../apps/cli/src/remove.ts";
import { createStartCommand } from "../apps/cli/src/start.ts";
import { createStopCommand } from "../apps/cli/src/stop.ts";
import { createDiagnostic, failure, type Diagnostic } from "../packages/diagnostics/src/index.ts";
import {
  CanonicalPath,
  NodeCanonicalPathLayer,
  ProjectEvaluator,
} from "../packages/project-loader/src/index.ts";
import { createProjectList, type Project } from "../packages/protocol/src/index.ts";
import { Effect, Layer } from "effect";

const cliVersion = "1.2.3";
type TestCliServices = ProjectClient | ProjectEvaluator;
type TestCliDependencies = CliDependencies<TestCliServices>;

test("the CLI dispatches injected commands without knowing their implementation", async () => {
  const receivedValues: string[] = [];
  const reportedDiagnostics: Diagnostic[] = [];
  const output: string[] = [];
  const command = defineCliCommand("custom", "SYD9000", {
    args: {
      value: Argument.string("value"),
    },
    meta: { description: "A test command" },
    run({ args }) {
      return Effect.sync(() => {
        receivedValues.push(args.value);
        return 7;
      });
    },
  });

  const exitCode = await runCli(["custom", "value"], {
    commands: [command],
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    version: cliVersion,
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
  const command = defineCliCommand("custom", "SYD9000", {
    args: {
      value: Argument.string("value").pipe(
        Argument.withDescription("Input value"),
        Argument.optional,
      ),
    },
    meta: { description: "A test command" },
    run() {
      return Effect.die(new Error("Help must not run the command."));
    },
  });

  const exitCode = await runCli(["custom", "--help"], {
    commands: [command],
    diagnostics: { report() {} },
    version: cliVersion,
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(exitCode).toBe(0);
  expect(output.join("\n")).toContain("USAGE\n  stackyard custom");
  expect(output.join("\n")).toContain("Input value");
});

test("the CLI reports its version through either root flag", async () => {
  const output: string[] = [];
  const dependencies: TestCliDependencies = {
    commands: [],
    diagnostics: {
      report() {
        throw new Error("Version output must not report a diagnostic.");
      },
    },
    version: cliVersion,
    writeOutput(value) {
      output.push(value);
    },
  };

  expect(await runCli(["--version"], dependencies)).toBe(0);
  expect(await runCli(["-v"], dependencies)).toBe(0);
  expect(output).toEqual([`stackyard v${cliVersion}\n`, `stackyard v${cliVersion}\n`]);
});

test("root help identifies the running CLI", async () => {
  const output: string[] = [];
  const exitCode = await runCli(["help"], {
    commands: [],
    diagnostics: { report() {} },
    version: cliVersion,
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(exitCode).toBe(0);
  expect(output.join("\n")).toContain("Manage local development projects");
});

test("the CLI prints help without running a command when invoked without arguments", async () => {
  let executions = 0;
  const output: string[] = [];
  const command = defineCliCommand("default", "SYD9000", {
    args: {},
    meta: { description: "Default command" },
    run() {
      return Effect.sync(() => {
        executions += 1;
        return 0;
      });
    },
  });

  expect(
    await runCli([], {
      commands: [command],
      diagnostics: { report() {} },
      version: cliVersion,
      writeOutput(value) {
        output.push(value);
      },
    }),
  ).toBe(0);
  expect(executions).toBe(0);
  expect(output.join("")).toContain("USAGE\n  stackyard");
  expect(output.join("")).toContain("default");
});

test("the CLI dispatches nested daemon commands and renders contextual help", async () => {
  let executions = 0;
  const output: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const start = defineCliCommand(
    "start",
    "SYD9000",
    {
      args: {},
      meta: { description: "Start test daemon" },
      run() {
        return Effect.sync(() => {
          executions += 1;
          return 0;
        });
      },
    },
    "daemon start",
  );
  const daemon = createDaemonCommand([start]);
  const dependencies: TestCliDependencies = {
    commands: [daemon],
    diagnostics: { report: (diagnostic) => diagnostics.push(diagnostic) },
    version: cliVersion,
    writeOutput: (value) => output.push(value),
  };

  expect(await runCli(["daemon", "start"], dependencies)).toBe(0);
  expect(executions).toBe(1);
  expect(await runCli(["daemon"], dependencies)).toBe(0);
  expect(output.join("")).toContain("USAGE\n  stackyard daemon");
  expect(await runCli(["daemon", "unknown"], dependencies)).toBe(1);
  expect(diagnostics).toMatchObject([
    {
      code: "SYD2019",
      help: "Run 'stackyard daemon --help' to list the available commands.",
    },
  ]);
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
    version: cliVersion,
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
    loadProject: () => Effect.die(new Error("Invalid arguments must not load a project.")),
    writeError() {},
    writeOutput() {},
  });

  const cliDependencies: TestCliDependencies = {
    commands: [command],
    diagnostics: {
      report(diagnostic) {
        reportedDiagnostics.push(diagnostic);
      },
    },
    version: cliVersion,
    writeOutput() {},
  };

  expect(await runCli(["inspect", "--unknown"], cliDependencies)).toBe(1);
  expect(reportedDiagnostics).toHaveLength(1);
  expect(reportedDiagnostics[0]?.code).toBe("SYD2005");
  expect(reportedDiagnostics[0]?.message).toBe("Unknown option '--unknown'.");
  expect(reportedDiagnostics[0]?.help).toBe(
    "Run 'stackyard inspect --help' to see the accepted arguments.",
  );

  reportedDiagnostics.length = 0;
  expect(await runCli(["inspect", "one", "two"], cliDependencies)).toBe(1);
  expect(reportedDiagnostics[0]?.message).toBe('Unexpected positional argument: "two"');
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
    loadProject: () =>
      Effect.fail({
        ...failure(createDiagnostic({ code: "SYD9000", message: "Expected failure." })),
        stderr: { text: "", truncated: false },
        stdout: { text: "partial output", truncated: true },
      }),
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
    version: cliVersion,
    writeOutput() {},
  });

  expect(exitCode).toBe(1);
  expect(errors.join("")).toBe("partial output\n");
  expect(reportedDiagnostics.map(({ code }) => code)).toEqual(["SYD2008", "SYD9000"]);
  expect(reportedDiagnostics[0]?.severity).toBe("warning");
  expect(reportedDiagnostics[0]?.help).toContain("stdout");
});

test("add sends the current project to the daemon", async () => {
  const paths: string[] = [];
  const output: string[] = [];
  const project = durableProject();
  const command = createAddCommand({
    currentDirectory: resolve("C:/projects/demo"),
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });
  const client = projectClient({
    add: (path) =>
      Effect.sync(() => {
        paths.push(path);
        return project;
      }),
  });

  const exitCode = await executeProjectCommand(command, [], client);

  expect(exitCode).toBe(0);
  expect(paths).toEqual([resolve("C:/projects/demo")]);
  expect(output.join("")).toContain("Added 'demo' to Stackyard.");
});

test("remove forgets only the project and says that files are unchanged", async () => {
  const targets: string[] = [];
  const output: string[] = [];
  const command = createRemoveCommand({
    currentDirectory: resolve("C:/projects"),
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });
  const client = projectClient({
    remove: (target) =>
      Effect.sync(() => {
        targets.push(target);
        return durableProject();
      }),
  });

  expect(await executeProjectCommand(command, ["demo"], client)).toBe(0);
  expect(targets).toEqual(["demo"]);
  expect(output.join("")).toContain("Project files were not changed.");
});

test("remove resolves a project directory to its canonical root", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-remove-"));
  const projectRoot = join(temporaryRoot, "project");
  const projectLink = join(temporaryRoot, "project-link");
  const targets: string[] = [];

  try {
    await mkdir(projectRoot);
    await symlink(projectRoot, projectLink, process.platform === "win32" ? "junction" : "dir");
    const command = createRemoveCommand({
      currentDirectory: temporaryRoot,
      diagnostics: { report() {} },
      writeOutput() {},
    });
    const client = projectClient({
      remove: (target) =>
        Effect.sync(() => {
          targets.push(target);
          return durableProject();
        }),
    });

    expect(await executeProjectCommand(command, ["./project-link"], client)).toBe(0);
    expect(targets).toEqual([await realpath(projectRoot)]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("list renders durable project state and supports protocol JSON", async () => {
  const output: string[] = [];
  const project = durableProject();
  const command = createListCommand({
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });
  const client = projectClient({
    list: Effect.succeed(createProjectList({ projects: [project] })),
  });

  expect(await executeProjectCommand(command, [], client)).toBe(0);
  expect(output.join("")).toContain("State: stopped");
  expect(output.join("")).toContain("Services: 1 service");
  output.length = 0;
  expect(await executeProjectCommand(command, ["--json"], client)).toBe(0);
  expect(JSON.parse(output.join(""))).toEqual(createProjectList({ projects: [project] }));
});

test("start reports one stable dashboard URL in detached and foreground modes", async () => {
  const output: string[] = [];
  let detachedStarts = 0;
  let foregroundStarts = 0;
  const locator = daemonLocator();
  const command = createStartCommand({
    diagnostics: { report() {} },
    find: () => Effect.succeed(undefined),
    runForeground: (onStarted) =>
      Effect.sync(() => {
        foregroundStarts += 1;
        onStarted(locator);
        return 0;
      }),
    start: () =>
      Effect.sync(() => {
        detachedStarts += 1;
        return locator;
      }),
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(await executePlainCommand(command)).toBe(0);
  expect(detachedStarts).toBe(1);
  expect(output.join("")).toBe("Stackyard is running at http://127.0.0.1:4310/\n");

  output.length = 0;
  expect(await executePlainCommand(command, ["--foreground"])).toBe(0);
  expect(foregroundStarts).toBe(1);
  expect(output.join("")).toBe(
    "Stackyard is running at http://127.0.0.1:4310/\nPress Ctrl+C to stop.\n",
  );
});

test("foreground start refuses to pretend it attached to an existing daemon", async () => {
  const diagnostics: Diagnostic[] = [];
  let foregroundStarts = 0;
  const command = createStartCommand({
    diagnostics: { report: (diagnostic) => diagnostics.push(diagnostic) },
    find: () => Effect.succeed(daemonLocator()),
    runForeground: () =>
      Effect.sync(() => {
        foregroundStarts += 1;
        return 0;
      }),
    start: () => Effect.die(new Error("Unexpected detached start.")),
    writeOutput() {},
  });

  expect(await executePlainCommand(command, ["--foreground"])).toBe(1);
  expect(foregroundStarts).toBe(0);
  expect(diagnostics).toMatchObject([
    {
      code: "SYD2016",
      help: "Run 'stackyard daemon stop', then start Stackyard in the foreground.",
      message: "Stackyard is already running.",
    },
  ]);
});

test("daemon stop is idempotent and reports whether a daemon was running", async () => {
  const output: string[] = [];
  const statuses: ("not-running" | "stopped")[] = ["stopped", "not-running"];
  const command = createDaemonStopCommand({
    diagnostics: { report() {} },
    stop: () =>
      Effect.sync(() => {
        const status = statuses.shift();
        if (!status) {
          throw new Error("Unexpected stop request.");
        }
        return status;
      }),
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(await executePlainCommand(command)).toBe(0);
  expect(await executePlainCommand(command)).toBe(0);
  expect(output).toEqual(["Stackyard stopped.\n", "Stackyard is not running.\n"]);
});

test("daemon status reports both lifecycle states", async () => {
  const output: string[] = [];
  const locators = [daemonLocator(), undefined];
  const command = createDaemonStatusCommand({
    diagnostics: { report() {} },
    find: () => Effect.sync(() => locators.shift()),
    writeOutput: (value) => output.push(value),
  });

  expect(await executePlainCommand(command)).toBe(0);
  expect(await executePlainCommand(command)).toBe(0);
  expect(output).toEqual([
    "Stackyard is running at http://127.0.0.1:4310/\nPID: 123\n",
    "Stackyard is not running.\n",
  ]);
});

test("stop resolves the project containing the current directory", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-stop-"));
  const projectRoot = join(temporaryRoot, "project");
  const nestedDirectory = join(projectRoot, "src");
  const targets: string[] = [];

  try {
    await mkdir(join(projectRoot, "stackyard"), { recursive: true });
    await mkdir(nestedDirectory);
    await writeFile(join(projectRoot, "stackyard", "main.ts"), "export {};\n");
    const command = createStopCommand({
      currentDirectory: nestedDirectory,
      diagnostics: { report() {} },
      writeOutput() {},
    });
    const client = projectClient({
      stop: (target) =>
        Effect.sync(() => {
          targets.push(target);
          return { kind: "stopped", project: durableProject() } as const;
        }),
    });

    expect(await executeProjectCommand(command, [], client)).toBe(0);
    expect(targets).toEqual([await realpath(projectRoot)]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("stop does not start Stackyard when the daemon is not running", async () => {
  const output: string[] = [];
  const command = createStopCommand({
    currentDirectory: resolve("C:/projects"),
    diagnostics: { report() {} },
    writeOutput: (value) => output.push(value),
  });
  const client = projectClient({
    stop: () => Effect.succeed({ kind: "daemon-not-running" } as const),
  });

  expect(await executeProjectCommand(command, ["demo"], client)).toBe(0);
  expect(output).toEqual(["No project is running because Stackyard is not running.\n"]);
});

function runCli(args: readonly string[], dependencies: TestCliDependencies): Promise<number> {
  return Effect.runPromise(
    runCliEffect(args, dependencies).pipe(
      Effect.provide(NodeCanonicalPathLayer),
      Effect.provide(BunServices.layer),
      Effect.provide(
        Layer.merge(
          Layer.succeed(ProjectClient, projectClient()),
          Layer.succeed(
            ProjectEvaluator,
            ProjectEvaluator.of({
              evaluate: () => Effect.die(new Error("Unexpected project evaluation.")),
            }),
          ),
        ),
      ),
    ),
  );
}

function executePlainCommand(command: CliCommand, args: readonly string[] = []): Promise<number> {
  return Effect.runPromise(
    runCliEffect([command.name, ...args], {
      commands: [command],
      diagnostics: { report() {} },
      version: cliVersion,
      writeOutput() {},
    }).pipe(Effect.provide(NodeCanonicalPathLayer), Effect.provide(BunServices.layer)),
  );
}

function executeProjectCommand(
  command: CliCommand<BunServices.BunServices | CanonicalPath | ProjectClient>,
  args: readonly string[],
  client: ProjectClient["Service"],
): Promise<number> {
  return Effect.runPromise(
    runCliEffect([command.name, ...args], {
      commands: [command],
      diagnostics: { report() {} },
      version: cliVersion,
      writeOutput() {},
    }).pipe(
      Effect.provide(NodeCanonicalPathLayer),
      Effect.provide(BunServices.layer),
      Effect.provideService(ProjectClient, client),
    ),
  );
}

function projectClient(
  overrides: Partial<ProjectClient["Service"]> = {},
): ProjectClient["Service"] {
  return ProjectClient.of({
    add: () => unexpectedProjectOperation("add"),
    list: unexpectedProjectOperation("list"),
    remove: () => unexpectedProjectOperation("remove"),
    stop: () => unexpectedProjectOperation("stop"),
    ...overrides,
  });
}

function unexpectedProjectOperation(operation: string) {
  return Effect.die(new Error(`Unexpected project client ${operation}.`));
}

function durableProject(): Project {
  return {
    id: "project-one",
    name: "demo",
    restartRequired: false,
    root: resolve("C:/projects/demo"),
    services: [{ endpoints: [], name: "api", state: "stopped" }],
    state: "stopped",
  };
}

function daemonLocator() {
  return {
    instanceId: "daemon-one",
    pid: 123,
    port: 4310,
    protocolVersion: 1 as const,
    schemaVersion: 1 as const,
    token: "test-token",
  };
}
