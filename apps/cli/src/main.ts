#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { formatDiagnostic, type DiagnosticSink } from "@stackyard/diagnostics";
import {
  loadProject as loadProjectDefinition,
  runProjectEvaluator,
} from "@stackyard/project-loader";

import { runCli } from "./cli.ts";
import { createInspectCommand } from "./inspect.ts";

const cliEntrypoint = fileURLToPath(import.meta.url);
const [command, ...args] = Bun.argv.slice(2);
const diagnostics: DiagnosticSink = {
  report(diagnostic) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  },
};

process.exitCode =
  command === "__stackyard_evaluate__"
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
        ],
        diagnostics,
        writeOutput(output) {
          process.stdout.write(output);
        },
      });
