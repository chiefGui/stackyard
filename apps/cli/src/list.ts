import type { DiagnosticSink, Failure } from "@stackyard/diagnostics";
import type { Project } from "@stackyard/protocol";
import { Effect } from "effect";
import { Flag } from "effect/unstable/cli";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";
import { ProjectClient } from "./project-client.ts";

export interface ListCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createListCommand(
  dependencies: ListCommandDependencies,
): CliCommand<ProjectClient> {
  return defineCliCommand("list", "SYD2015", {
    args: {
      json: Flag.boolean("json").pipe(
        Flag.withDescription("Print compact JSON"),
        Flag.withDefault(false),
      ),
    },
    meta: { description: "List projects" },
    run({ args }) {
      return reportCommandFailure(
        listProjects(args.json ?? false, dependencies),
        dependencies.diagnostics,
      );
    },
  });
}

const listProjects = Effect.fn("listProjects")(function* (
  json: boolean,
  dependencies: ListCommandDependencies,
): Effect.fn.Return<number, Failure, ProjectClient> {
  const client = yield* ProjectClient;
  const listed = yield* client.list;
  if (json) {
    dependencies.writeOutput(`${JSON.stringify(listed)}\n`);
    return 0;
  }
  if (listed.projects.length === 0) {
    dependencies.writeOutput("No projects yet. Run 'stackyard add .' from a project.\n");
    return 0;
  }

  dependencies.writeOutput(`${listed.projects.map(formatProject).join("\n\n")}\n`);
  return 0;
});

function formatProject(project: Project): string {
  const lines = [project.name, `  State: ${formatState(project.state)}`];
  if (project.restartRequired) {
    lines.push("  Restart required: yes");
  }
  lines.push(
    `  Services: ${formatServiceCount(project.services.length)}`,
    `  ID: ${project.id}`,
    `  Root: ${project.root}`,
  );
  const first = project.issue?.diagnostics[0];
  if (first) {
    lines.push(`  Issue: ${first.code}: ${first.message}`);
  }
  return lines.join("\n");
}

function formatState(state: Project["state"]): string {
  return state.replaceAll("-", " ");
}

function formatServiceCount(count: number): string {
  return `${count} ${count === 1 ? "service" : "services"}`;
}
