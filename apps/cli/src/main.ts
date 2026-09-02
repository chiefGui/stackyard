#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { internalDaemonCommand } from "@stackyard/daemon/locator";
import { runManagedDaemon } from "@stackyard/daemon/managed";
import { formatDiagnostic, type DiagnosticSink } from "@stackyard/diagnostics";
import {
  loadProject as loadProjectDefinition,
  projectEvaluatorCommand,
  runProjectEvaluator,
} from "@stackyard/project-loader";

import packageManifest from "../package.json" with { type: "json" };
import { runCli } from "./cli.ts";
import { createAddCommand } from "./add.ts";
import { createInspectCommand } from "./inspect.ts";
import { DaemonProjectClient } from "./project-client.ts";
import { createRemoveCommand } from "./remove.ts";
import { createRunCommand } from "./run.ts";
import { createStatusCommand } from "./status.ts";

const cliEntrypoint = fileURLToPath(import.meta.url);
const cliArguments = Bun.argv.slice(2);
const [command, ...commandArguments] = cliArguments;
let diagnosticsPath: string | undefined;
if (command === internalDaemonCommand) {
  diagnosticsPath = Bun.env.STACKYARD_DIAGNOSTICS_PATH;
}
const diagnostics = createDiagnosticSink(diagnosticsPath);

process.exitCode = await main();

function main(): Promise<number> {
  if (command === internalDaemonCommand) {
    return runDaemon();
  }
  if (command === projectEvaluatorCommand) {
    return runProjectEvaluator(commandArguments[0] ?? "");
  }
  return runPublicCli();
}

function runDaemon(): Promise<number> {
  const configuredDashboardDirectory = Bun.env.STACKYARD_DASHBOARD_WEB_DIR;
  const dashboardWebDirectory =
    configuredDashboardDirectory ?? resolveDashboardWebDirectory(cliEntrypoint);
  return runManagedDaemon({
    dashboardWebDirectory,
    diagnostics,
    evaluatorEntrypoint: cliEntrypoint,
  });
}

function runPublicCli(): Promise<number> {
  const dashboardWebDirectory = resolveDashboardWebDirectory(cliEntrypoint);
  const projectClient = new DaemonProjectClient({
    daemonEntrypoint: cliEntrypoint,
    dashboardWebDirectory,
  });
  return runCli(cliArguments, {
    commands: [
      createAddCommand({
        client: projectClient,
        currentDirectory: process.cwd(),
        diagnostics,
        writeOutput(output) {
          process.stdout.write(output);
        },
      }),
      createInspectCommand({
        diagnostics,
        loadProject,
        writeError(output) {
          process.stderr.write(output);
        },
        writeOutput(output) {
          process.stdout.write(output);
        },
      }),
      createRunCommand({
        currentDirectory: process.cwd(),
        daemonEntrypoint: cliEntrypoint,
        dashboardWebDirectory,
        diagnostics,
        writeOutput(output) {
          process.stdout.write(output);
        },
      }),
      createRemoveCommand({
        client: projectClient,
        currentDirectory: process.cwd(),
        diagnostics,
        writeOutput(output) {
          process.stdout.write(output);
        },
      }),
      createStatusCommand({
        client: projectClient,
        diagnostics,
        writeOutput(output) {
          process.stdout.write(output);
        },
      }),
    ],
    diagnostics,
    version: packageManifest.version,
    writeOutput(output) {
      process.stdout.write(output);
    },
  });
}

function loadProject(path: string | undefined) {
  const options = {
    currentDirectory: process.cwd(),
    evaluatorEntrypoint: cliEntrypoint,
  };
  if (path) {
    return loadProjectDefinition({ ...options, path });
  }
  return loadProjectDefinition(options);
}

function resolveDashboardWebDirectory(entrypoint: string): string {
  const directory = dirname(entrypoint);
  if (basename(directory) === "src") {
    return resolve(directory, "../../dashboard-web/dist");
  }
  return join(directory, "dashboard-web");
}

function createDiagnosticSink(path: string | undefined): DiagnosticSink {
  let captured = "";
  return {
    report(diagnostic) {
      const formatted = `${formatDiagnostic(diagnostic)}\n`;
      if (!path) {
        process.stderr.write(formatted);
        return;
      }

      captured = `${captured}${formatted}`.slice(-64 * 1024);
      try {
        writeFileSync(path, captured, { encoding: "utf8", mode: 0o600 });
      } catch {
        process.stderr.write(formatted);
      }
    },
  };
}
