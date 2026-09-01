import { createDiagnostic, failure, success, type Result } from "@stackyard/diagnostics";

import { deepFreeze } from "./freeze.ts";
import { isLoopbackHttpUrl } from "./loopback-url.ts";
import { protocolVersion } from "./version.ts";

export type ResourceState = "starting" | "running" | "stopping" | "exited" | "failed";

export interface RuntimeEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface RuntimeResource {
  readonly endpoints: readonly RuntimeEndpoint[];
  readonly exitCode?: number | undefined;
  readonly name: string;
  readonly state: ResourceState;
}

export interface RuntimeProject {
  readonly id: string;
  readonly name: string;
  readonly resources: readonly RuntimeResource[];
}

export interface RuntimeSnapshot {
  readonly projects: readonly RuntimeProject[];
  readonly revision: number;
  readonly schemaVersion: typeof protocolVersion;
}

export function createRuntimeSnapshot(
  input: Omit<RuntimeSnapshot, "schemaVersion">,
): RuntimeSnapshot {
  return deepFreeze({ ...input, schemaVersion: protocolVersion });
}

export function parseRuntimeSnapshot(input: unknown): Result<RuntimeSnapshot> {
  if (!isPlainObject(input) || !hasExactKeys(input, ["projects", "revision", "schemaVersion"])) {
    return invalidSnapshot();
  }
  if (
    input.schemaVersion !== protocolVersion ||
    !isNonNegativeInteger(input.revision) ||
    !Array.isArray(input.projects)
  ) {
    return invalidSnapshot();
  }

  const projects: RuntimeProject[] = [];
  for (const project of input.projects) {
    const parsed = parseRuntimeProject(project);
    if (!parsed) {
      return invalidSnapshot();
    }
    projects.push(parsed);
  }

  return success(
    deepFreeze({ projects, revision: input.revision, schemaVersion: protocolVersion }),
  );
}

function parseRuntimeProject(input: unknown): RuntimeProject | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["id", "name", "resources"]) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.name) ||
    !Array.isArray(input.resources)
  ) {
    return undefined;
  }

  const resources: RuntimeResource[] = [];
  for (const resource of input.resources) {
    const parsed = parseRuntimeResource(resource);
    if (!parsed) {
      return undefined;
    }
    resources.push(parsed);
  }

  return { id: input.id, name: input.name, resources };
}

function parseRuntimeResource(input: unknown): RuntimeResource | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["endpoints", "name", "state"], ["exitCode"]) ||
    !Array.isArray(input.endpoints) ||
    !isNonEmptyString(input.name) ||
    !isResourceState(input.state) ||
    (input.exitCode !== undefined &&
      (typeof input.exitCode !== "number" || !Number.isSafeInteger(input.exitCode)))
  ) {
    return undefined;
  }

  const endpoints: RuntimeEndpoint[] = [];
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isResourceState(value: unknown): value is ResourceState {
  return (
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "exited" ||
    value === "failed"
  );
}

function invalidSnapshot(): Result<RuntimeSnapshot> {
  return failure(
    createDiagnostic({
      code: "SYD1200",
      help: "Update Stackyard so the dashboard and daemon use the same protocol, then retry.",
      message: "Runtime snapshot is invalid.",
    }),
  );
}
