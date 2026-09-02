import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAddCommand } from "../apps/cli/src/add.ts";
import { defineCliCommand, runCli, type CliDependencies } from "../apps/cli/src/cli.ts";
import { createInspectCommand } from "../apps/cli/src/inspect.ts";
import { createRemoveCommand } from "../apps/cli/src/remove.ts";
import { createStatusCommand } from "../apps/cli/src/status.ts";
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
  const exitCode = await runCli([], {
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
