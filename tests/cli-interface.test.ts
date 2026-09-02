import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAddCommand } from "../apps/cli/src/add.ts";
import { defineCliCommand, runCli, type CliDependencies } from "../apps/cli/src/cli.ts";
import { createInspectCommand } from "../apps/cli/src/inspect.ts";
import { createRemoveCommand } from "../apps/cli/src/remove.ts";
import { createStartCommand } from "../apps/cli/src/start.ts";
import { createStatusCommand } from "../apps/cli/src/status.ts";
import { createStopCommand } from "../apps/cli/src/stop.ts";
import {
  createDiagnostic,
  failure,
  success,
  type Diagnostic,
} from "../packages/diagnostics/src/index.ts";
import { createProjectList, type Project } from "../packages/protocol/src/index.ts";

const cliVersion = "1.2.3";

test("the CLI dispatches injected commands without knowing their implementation", async () => {
  const receivedValues: string[] = [];
  const reportedDiagnostics: Diagnostic[] = [];
  const output: string[] = [];
  const command = defineCliCommand("custom", "SYD9000", {
    args: {
      value: { required: true, type: "positional" },
    },
    meta: { description: "A test command" },
    async run({ args }) {
      receivedValues.push(args.value);
      return 7;
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
      value: { description: "Input value", required: false, type: "positional" },
    },
    meta: { description: "A test command" },
    run() {
      throw new Error("Help must not run the command.");
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
  expect(output.join("\n")).toContain("USAGE stackyard custom");
  expect(output.join("\n")).toContain("Input value");
});

test("the CLI reports its version through either root flag", async () => {
  const output: string[] = [];
  const dependencies: CliDependencies = {
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
  expect(output).toEqual([`${cliVersion}\n`, `${cliVersion}\n`]);
});

test("root help identifies the running CLI version", async () => {
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
  expect(output.join("\n")).toContain(`stackyard v${cliVersion}`);
});

test("the CLI runs its default command without arguments", async () => {
  let executions = 0;
  const command = defineCliCommand("default", "SYD9000", {
    meta: { description: "Default command" },
    run() {
      executions += 1;
      return 0;
    },
  });

  expect(
    await runCli([], {
      commands: [command],
      defaultCommand: command,
      diagnostics: { report() {} },
      version: cliVersion,
      writeOutput() {},
    }),
  ).toBe(0);
  expect(executions).toBe(1);
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
    async loadProject() {
      throw new Error("Invalid arguments must not load a project.");
    },
    writeError() {},
    writeOutput() {},
  });

  const cliDependencies: CliDependencies = {
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
  expect(reportedDiagnostics[0]?.message).toBe(
    "Command 'inspect' accepts at most one positional argument.",
  );
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
    client: {
      async add(path) {
        paths.push(path);
        return success(project);
      },
      async list() {
        throw new Error("Unexpected list request.");
      },
      async remove() {
        throw new Error("Unexpected remove request.");
      },
    },
    currentDirectory: resolve("C:/projects/demo"),
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });

  const exitCode = await command.execute([]);

  expect(exitCode).toBe(0);
  expect(paths).toEqual([resolve("C:/projects/demo")]);
  expect(output.join("")).toContain("Added 'demo' to Stackyard.");
});

test("remove forgets only the project and says that files are unchanged", async () => {
  const targets: string[] = [];
  const output: string[] = [];
  const command = createRemoveCommand({
    client: {
      async add() {
        throw new Error("Unexpected add request.");
      },
      async list() {
        throw new Error("Unexpected list request.");
      },
      async remove(target) {
        targets.push(target);
        return success(durableProject());
      },
    },
    currentDirectory: resolve("C:/projects"),
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(await command.execute(["demo"])).toBe(0);
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
      client: {
        async add() {
          throw new Error("Unexpected add request.");
        },
        async list() {
          throw new Error("Unexpected list request.");
        },
        async remove(target) {
          targets.push(target);
          return success(durableProject());
        },
      },
      currentDirectory: temporaryRoot,
      diagnostics: { report() {} },
      writeOutput() {},
    });

    expect(await command.execute(["./project-link"])).toBe(0);
    expect(targets).toEqual([await realpath(projectRoot)]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("status renders durable project state and supports protocol JSON", async () => {
  const output: string[] = [];
  const project = durableProject();
  const command = createStatusCommand({
    client: {
      async add() {
        throw new Error("Unexpected add request.");
      },
      async list() {
        return success(createProjectList({ projects: [project] }));
      },
      async remove() {
        throw new Error("Unexpected remove request.");
      },
    },
    diagnostics: { report() {} },
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(await command.execute([])).toBe(0);
  expect(output.join("")).toContain("State: stopped");
  expect(output.join("")).toContain("Services: 1 service");
  output.length = 0;
  expect(await command.execute(["--json"])).toBe(0);
  expect(JSON.parse(output.join(""))).toEqual(createProjectList({ projects: [project] }));
});

test("start reports one stable dashboard URL in detached and foreground modes", async () => {
  const output: string[] = [];
  let detachedStarts = 0;
  let foregroundStarts = 0;
  const locator = daemonLocator();
  const command = createStartCommand({
    diagnostics: { report() {} },
    async find() {
      return success(undefined);
    },
    async runForeground(onStarted) {
      foregroundStarts += 1;
      onStarted(locator);
      return 0;
    },
    async start() {
      detachedStarts += 1;
      return success(locator);
    },
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(await command.execute([])).toBe(0);
  expect(detachedStarts).toBe(1);
  expect(output.join("")).toBe("Stackyard is running at http://127.0.0.1:4310/\n");

  output.length = 0;
  expect(await command.execute(["--foreground"])).toBe(0);
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
    async find() {
      return success(daemonLocator());
    },
    async runForeground() {
      foregroundStarts += 1;
      return 0;
    },
    async start() {
      throw new Error("Unexpected detached start.");
    },
    writeOutput() {},
  });

  expect(await command.execute(["--foreground"])).toBe(1);
  expect(foregroundStarts).toBe(0);
  expect(diagnostics).toMatchObject([
    {
      code: "SYD2016",
      help: "Run 'stackyard stop', then start Stackyard in the foreground.",
      message: "Stackyard is already running.",
    },
  ]);
});

test("stop is idempotent and reports whether a daemon was running", async () => {
  const output: string[] = [];
  const statuses: ("not-running" | "stopped")[] = ["stopped", "not-running"];
  const command = createStopCommand({
    diagnostics: { report() {} },
    async stop() {
      const status = statuses.shift();
      if (!status) {
        throw new Error("Unexpected stop request.");
      }
      return success(status);
    },
    writeOutput(value) {
      output.push(value);
    },
  });

  expect(await command.execute([])).toBe(0);
  expect(await command.execute([])).toBe(0);
  expect(output).toEqual(["Stackyard stopped.\n", "Stackyard is not running.\n"]);
});

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
