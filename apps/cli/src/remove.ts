import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { ProjectClient } from "./project-client.ts";
import { normalizeProjectTarget } from "./project-target.ts";

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
  const removed = await dependencies.client.remove(
    await normalizeProjectTarget(target, dependencies.currentDirectory),
  );
  if (!removed.success) {
    reportDiagnostics(dependencies.diagnostics, removed.diagnostics);
    return 1;
  }

  dependencies.writeOutput(
    `Removed '${removed.output.name}' from Stackyard.\nProject files were not changed.\n`,
  );
  return 0;
}
