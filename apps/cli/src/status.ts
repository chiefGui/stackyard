import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import type { RegisteredProject } from "@stackyard/protocol";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { RegistrationClient } from "./registration-client.ts";
import { definitionSpec, registeredProjectLabel } from "./registration-output.ts";

export interface StatusCommandDependencies {
  readonly client: RegistrationClient;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createStatusCommand(dependencies: StatusCommandDependencies): CliCommand {
  return defineCliCommand("status", "SYD2015", {
    args: {
      json: { description: "Print compact JSON", type: "boolean" },
    },
    meta: { description: "List registered projects" },
    run({ args }) {
      return showStatus(args.json ?? false, dependencies);
    },
  });
}

async function showStatus(json: boolean, dependencies: StatusCommandDependencies): Promise<number> {
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
    dependencies.writeOutput("No projects are registered. Run 'stackyard add .' from a project.\n");
    return 0;
  }

  dependencies.writeOutput(`${listed.output.projects.map(formatProject).join("\n\n")}\n`);
  return 0;
}

function formatProject(project: RegisteredProject): string {
  const spec = definitionSpec(project.definition);
  const lines = [registeredProjectLabel(project), `  ID: ${project.id}`, `  Root: ${project.root}`];
  if (project.definition.kind === "valid") {
    lines.push(
      `  Definition: valid (${formatServiceCount(Object.keys(project.definition.spec.resources).length)})`,
    );
  } else if (project.definition.kind === "loading") {
    lines.push("  Definition: loading");
  } else {
    const first = project.definition.diagnostics[0];
    lines.push(
      `  Definition: ${project.definition.kind}${first ? ` (${first.code}: ${first.message})` : ""}`,
    );
    if (spec) {
      lines.push(
        `  Last valid definition: ${formatServiceCount(Object.keys(spec.resources).length)}`,
      );
    }
  }
  return lines.join("\n");
}

function formatServiceCount(count: number): string {
  return `${count} ${count === 1 ? "service" : "services"}`;
}
