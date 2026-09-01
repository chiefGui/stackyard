import { createDiagnostic, failure, success, type Result } from "@stackyard/diagnostics";

import { deepFreeze } from "./freeze.ts";
import { isLoopbackHttpUrl } from "./loopback-url.ts";
import { protocolVersion } from "./version.ts";

export type ServiceState = "starting" | "running" | "stopping" | "exited" | "failed";

export interface ServiceEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface Service {
  readonly endpoints: readonly ServiceEndpoint[];
  readonly exitCode?: number | undefined;
  readonly name: string;
  readonly state: ServiceState;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly services: readonly Service[];
}

export interface ProjectList {
  readonly projects: readonly Project[];
  readonly schemaVersion: typeof protocolVersion;
}

export function createProjectList(input: Omit<ProjectList, "schemaVersion">): ProjectList {
  return deepFreeze({ ...input, schemaVersion: protocolVersion });
}

export function parseProjectList(input: unknown): Result<ProjectList> {
  if (!isPlainObject(input) || !hasExactKeys(input, ["projects", "schemaVersion"])) {
    return invalidProjectList();
  }
  if (input.schemaVersion !== protocolVersion || !Array.isArray(input.projects)) {
    return invalidProjectList();
  }

  const projects: Project[] = [];
  for (const project of input.projects) {
    const parsed = parseProject(project);
    if (!parsed) {
      return invalidProjectList();
    }
    projects.push(parsed);
  }

  return success(deepFreeze({ projects, schemaVersion: protocolVersion }));
}

function parseProject(input: unknown): Project | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["id", "name", "services"]) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.name) ||
    !Array.isArray(input.services)
  ) {
    return undefined;
  }

  const services: Service[] = [];
  for (const service of input.services) {
    const parsed = parseService(service);
    if (!parsed) {
      return undefined;
    }
    services.push(parsed);
  }

  return { id: input.id, name: input.name, services };
}

function parseService(input: unknown): Service | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["endpoints", "name", "state"], ["exitCode"]) ||
    !Array.isArray(input.endpoints) ||
    !isNonEmptyString(input.name) ||
    !isServiceState(input.state) ||
    (input.exitCode !== undefined &&
      (typeof input.exitCode !== "number" || !Number.isSafeInteger(input.exitCode)))
  ) {
    return undefined;
  }

  const endpoints: ServiceEndpoint[] = [];
  for (const endpoint of input.endpoints) {
    if (
      !isPlainObject(endpoint) ||
      !hasExactKeys(endpoint, ["name", "url"]) ||
      !isNonEmptyString(endpoint.name) ||
      !isLoopbackHttpUrl(endpoint.url)
    ) {
      return undefined;
    }
    endpoints.push({ name: endpoint.name, url: endpoint.url });
  }

  return {
    endpoints,
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
    name: input.name,
    state: input.state,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isServiceState(value: unknown): value is ServiceState {
  return (
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "exited" ||
    value === "failed"
  );
}

function invalidProjectList(): Result<ProjectList> {
  return failure(
    createDiagnostic({
      code: "SYD1200",
      help: "Update Stackyard so the dashboard and daemon use the same protocol, then retry.",
      message: "Project list is invalid.",
    }),
  );
}
