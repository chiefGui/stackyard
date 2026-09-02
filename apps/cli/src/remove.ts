import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { ProjectClient } from "./project-client.ts";

export interface RemoveCommandDependencies {
  readonly client: ProjectClient;
  readonly currentDirectory: string;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createRemoveCommand(dependencies: RemoveCommandDependencies): CliCommand {
  return defineCliCommand("remove", "SYD2014", {
    args: {
      project: {
        description: "Project name, identifier, or directory",
        required: true,
        type: "positional",
      },
    },
    meta: { description: "Remove a project from Stackyard" },
    run({ args }) {
      return removeProject(args.project, dependencies);
    },
  });
}

async function removeProject(
  target: string,
  dependencies: RemoveCommandDependencies,
): Promise<number> {
  const removed = await dependencies.client.remove(await normalizeTarget(target, dependencies));
  if (!removed.success) {
    reportDiagnostics(dependencies.diagnostics, removed.diagnostics);
    return 1;
  }

  dependencies.writeOutput(
    `Removed '${removed.output.name}' from Stackyard.\nProject files were not changed.\n`,
  );
  return 0;
}

async function normalizeTarget(
  target: string,
  dependencies: RemoveCommandDependencies,
): Promise<string> {
  if (!isPathTarget(target)) {
    return target;
  }

  const absolute = resolve(dependencies.currentDirectory, target);
  try {
    return await realpath(absolute);
  } catch {
    // A missing project can still be forgotten by its stored absolute path.
    return absolute;
  }
}

function isPathTarget(target: string): boolean {
  return (
    isAbsolute(target) ||
    target === "." ||
    target === ".." ||
    target.startsWith(`.${sep}`) ||
    target.startsWith(`..${sep}`) ||
    target.includes("/") ||
    target.includes("\\")
  );
}
