#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

import { runCli } from "./cli.ts";
import { runEvaluator } from "./evaluator.ts";

const cliEntrypoint = fileURLToPath(import.meta.url);
const [command, ...args] = Bun.argv.slice(2);

process.exitCode =
  command === "__stackyard_evaluate__"
    ? await runEvaluator(args[0] ?? "")
    : await runCli(cliEntrypoint, Bun.argv.slice(2));
