#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureDaemon,
  findDaemon,
  internalDaemonCommand,
  stopDaemon,
} from "@stackyard/daemon/locator";
import { runManagedDaemon } from "@stackyard/daemon/managed";
import { formatDiagnostic, type DiagnosticSink } from "@stackyard/diagnostics";
import {
  loadProjectEffect,
  makeBunProjectEvaluatorLayer,
  type ProjectEvaluator,
  projectEvaluatorCommand,
  runProjectEvaluator,
} from "@stackyard/project-loader";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";

import packageManifest from "../package.json" with { type: "json" };
import { runCli, type CliEntry } from "./cli.ts";
import { createAddCommand } from "./add.ts";
import { createDaemonStatusCommand } from "./daemon-status.ts";
import { createDaemonStopCommand } from "./daemon-stop.ts";
import { createDaemonCommand } from "./daemon.ts";
import { createInspectCommand } from "./inspect.ts";
import { createListCommand } from "./list.ts";
import { makeDaemonProjectClientLayer, ProjectClient } from "./project-client.ts";
import { createRemoveCommand } from "./remove.ts";
import { createRunCommand } from "./run.ts";
import { createStartCommand } from "./start.ts";
import { createStopCommand } from "./stop.ts";

const cliEntrypoint = fileURLToPath(import.meta.url);
const cliArguments = Bun.argv.slice(2);
const [command, ...commandArguments] = cliArguments;
let diagnosticsPath: string | undefined;
if (command === internalDaemonCommand) {
  diagnosticsPath = Bun.env.STACKYARD_DIAGNOSTICS_PATH;
}
const diagnostics = createDiagnosticSink(diagnosticsPath);

BunRuntime.runMain(
  main().pipe(
    Effect.tap((exitCode) =>
      Effect.sync(() => {
        process.exitCode = exitCode;
      }),
    ),
    Effect.asVoid,
  ),
);

function main(): Effect.Effect<number> {
  if (command === internalDaemonCommand) {
    return runDaemon();
  }
  if (command === projectEvaluatorCommand) {
    return runProjectEvaluator(commandArguments[0] ?? "");
  }
  return runPublicCli();
}

function runDaemon(): Effect.Effect<number> {
  const configuredDashboardDirectory = Bun.env.STACKYARD_DASHBOARD_WEB_DIR;
  const dashboardWebDirectory =
    configuredDashboardDirectory ?? resolveDashboardWebDirectory(cliEntrypoint);
  return runManagedDaemon({
    dashboardWebDirectory,
    diagnostics,
    evaluatorEntrypoint: cliEntrypoint,
  });
}

function runPublicCli(): Effect.Effect<number> {
  const dashboardWebDirectory = resolveDashboardWebDirectory(cliEntrypoint);
  const daemonOptions = { daemonEntrypoint: cliEntrypoint, dashboardWebDirectory };
  const startCommand = createStartCommand({
    diagnostics,
    find: findDaemon,
    runForeground: (onStarted) =>
      runManagedDaemon({
        dashboardWebDirectory,
        diagnostics,
        evaluatorEntrypoint: cliEntrypoint,
        onStarted,
      }),
    start: () => ensureDaemon(daemonOptions),
    writeOutput,
  });
  const daemonCommand = createDaemonCommand([
    startCommand,
    createDaemonStatusCommand({ diagnostics, find: () => findDaemon(), writeOutput }),
    createDaemonStopCommand({ diagnostics, stop: () => stopDaemon(), writeOutput }),
  ]);
  const commands: readonly CliEntry<ProjectClient | ProjectEvaluator>[] = [
    createAddCommand({
      currentDirectory: process.cwd(),
      diagnostics,
      writeOutput,
    }),
    daemonCommand,
    createInspectCommand({
      diagnostics,
      loadProject,
      writeError(output) {
        process.stderr.write(output);
      },
      writeOutput,
    }),
    createListCommand({
      diagnostics,
      writeOutput,
    }),
    createRemoveCommand({
      currentDirectory: process.cwd(),
      diagnostics,
      writeOutput,
    }),
    createRunCommand({
      currentDirectory: process.cwd(),
      daemonEntrypoint: cliEntrypoint,
      dashboardWebDirectory,
      diagnostics,
      writeOutput,
    }),
    createStopCommand({
      currentDirectory: process.cwd(),
      diagnostics,
      writeOutput,
    }),
  ];
  return runCli(cliArguments, {
    commands,
    diagnostics,
    version: packageManifest.version,
    writeOutput,
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.provide(makeDaemonProjectClientLayer(daemonOptions)),
    Effect.provide(makeBunProjectEvaluatorLayer(cliEntrypoint)),
  );
}

function loadProject(path: string | undefined) {
  const options = { currentDirectory: process.cwd() };
  if (path) {
    return loadProjectEffect({ ...options, path });
  }
  return loadProjectEffect(options);
}

function resolveDashboardWebDirectory(entrypoint: string): string {
  const directory = dirname(entrypoint);
  if (basename(directory) === "src") {
    return resolve(directory, "../../dashboard-web/dist");
  }
  return join(directory, "dashboard-web");
}

function writeOutput(output: string): void {
  process.stdout.write(output);
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
