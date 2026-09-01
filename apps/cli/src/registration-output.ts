import type { RegisteredProject, RegisteredProjectDefinition } from "@stackyard/protocol";

function registeredProjectName(project: RegisteredProject): string | undefined {
  return definitionSpec(project.definition)?.name;
}

export function registeredProjectLabel(project: RegisteredProject): string {
  return registeredProjectName(project) ?? project.id;
}

export function definitionSpec(definition: RegisteredProjectDefinition) {
  if (definition.kind === "valid") {
    return definition.spec;
  }
  if (definition.kind === "invalid" || definition.kind === "missing") {
    return definition.lastValidSpec;
  }
  return undefined;
}
