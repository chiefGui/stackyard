import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import type { Project } from "@stackyard/protocol";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { ProjectClient } from "./project-client.ts";

export interface ListCommandDependencies {
  readonly client: ProjectClient;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createListCommand(dependencies: ListCommandDependencies): CliCommand {
  return defineCliCommand("list", "SYD2015", {
    args: {
      json: { description: "Print compact JSON", type: "boolean" },
    },
    meta: { description: "List projects" },
    run({ args }) {
      return listProjects(args.json ?? false, dependencies);
    },
  });
}

async function listProjects(json: boolean, dependencies: ListCommandDependencies): Promise<number> {
  const listed = await dependencies.client.list();
  if (!listed.success) {
    reportDiagnostics(dependencies.diagnostics, listed.diagnostics);
    return 1;
  }
  if (json) {
    dependencies.writeOutput(`${JSON.stringify(listed.output)}\n`);
    return 0;
  }
  if (listed.output.projects.length === 0) {
    dependencies.writeOutput("No projects yet. Run 'stackyard add .' from a project.\n");
    return 0;
  }

  dependencies.writeOutput(`${listed.output.projects.map(formatProject).join("\n\n")}\n`);
  return 0;
}

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
