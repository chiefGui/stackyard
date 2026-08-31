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

import { runCli } from "./cli.ts";
import { createInspectCommand } from "./inspect.ts";
import { createRunCommand } from "./run.ts";

const cliEntrypoint = fileURLToPath(import.meta.url);
const [command, ...args] = Bun.argv.slice(2);
const diagnostics = createDiagnosticSink(
  command === internalDaemonCommand ? Bun.env.STACKYARD_DIAGNOSTICS_PATH : undefined,
);
const dashboardDirectory = resolveDashboardDirectory(cliEntrypoint);

process.exitCode =
  command === internalDaemonCommand
    ? await runManagedDaemon({
        dashboardDirectory: Bun.env.STACKYARD_DASHBOARD_DIR ?? dashboardDirectory,
        diagnostics,
        ...(Bun.env.STACKYARD_RUNTIME_DIR
          ? { runtimeDirectory: Bun.env.STACKYARD_RUNTIME_DIR }
          : {}),
      })
    : command === projectEvaluatorCommand
      ? await runProjectEvaluator(args[0] ?? "")
      : await runCli(Bun.argv.slice(2), {
          commands: [
            createInspectCommand({
              diagnostics,
              loadProject(path) {
                return loadProjectDefinition({
                  currentDirectory: process.cwd(),
                  evaluatorEntrypoint: cliEntrypoint,
                  ...(path ? { path } : {}),
                });
              },
              writeError(output) {
                process.stderr.write(output);
              },
              writeOutput(output) {
                process.stdout.write(output);
              },
            }),
            createRunCommand({
              daemonEntrypoint: cliEntrypoint,
              dashboardDirectory,
              diagnostics,
              loadProject(path) {
                return loadProjectDefinition({
                  currentDirectory: process.cwd(),
                  evaluatorEntrypoint: cliEntrypoint,
                  ...(path ? { path } : {}),
                });
              },
              writeError(output) {
                process.stderr.write(output);
              },
              writeOutput(output) {
                process.stdout.write(output);
              },
            }),
          ],
          diagnostics,
          writeOutput(output) {
            process.stdout.write(output);
          },
        });

function resolveDashboardDirectory(entrypoint: string): string {
  const directory = dirname(entrypoint);
  return basename(directory) === "src"
    ? resolve(directory, "../../dashboard-web/dist")
    : join(directory, "dashboard");
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
