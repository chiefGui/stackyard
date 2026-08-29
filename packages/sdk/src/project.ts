import {
  parseProjectSpec,
  type Diagnostic,
  type EndpointValueExpression,
  type EnvironmentValueSpec,
  type ProcessResourceSpec,
  type ProjectSpec,
  type Result,
} from "@stackyard/protocol";

import {
  getEndpointState,
  getRuntimeValueState,
  getServiceState,
  type EndpointInputRecord,
  type ServiceDescriptor,
  type ServiceState,
} from "./descriptors.ts";

const projectDefinitionErrorSymbol = Symbol.for("stackyard.project-definition-error.v1");
const projectDefinitionSymbol = Symbol.for("stackyard.project-definition.v1");

export interface ProjectDefinition {
  readonly [projectDefinitionSymbol]: ProjectSpec;
}

export interface ProjectOptions<Resources extends ResourceInputRecord> {
  readonly name: string;
  readonly resources: Resources;
}

export type ResourceInputRecord = Readonly<Record<string, ServiceDescriptor<EndpointInputRecord>>>;

export class ProjectDefinitionError extends Error {
  readonly [projectDefinitionErrorSymbol] = true;
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics[0]?.message ?? "The project definition is invalid.");
    this.name = "ProjectDefinitionError";
    this.diagnostics = diagnostics;
  }
}

export function isProjectDefinitionError(error: unknown): error is ProjectDefinitionError {
  return (
    isObject(error) &&
    Reflect.get(error, projectDefinitionErrorSymbol) === true &&
    Array.isArray(Reflect.get(error, "diagnostics"))
  );
}

export function defineProject<const Resources extends ResourceInputRecord>(
  options: ProjectOptions<Resources>,
): ProjectDefinition {
  const diagnostics: Diagnostic[] = [];
  const resourceNames = new Map<ServiceState, string>();
  const resourceEntries = Object.entries(options.resources).sort(compareEntries);

  for (const [name, descriptor] of resourceEntries) {
    const state = getServiceState(descriptor);

    if (!state) {
      diagnostics.push({
        code: "SYD1100",
        message: "Must be a resource created by service().",
        path: ["resources", name],
      });
      continue;
    }

    const previousName = resourceNames.get(state);
    if (previousName) {
      diagnostics.push({
        code: "SYD1101",
        message: `The same service is already registered as '${previousName}'.`,
        path: ["resources", name],
      });
      continue;
    }

    resourceNames.set(state, name);
  }

  const resources: Record<string, ProcessResourceSpec> = {};

  for (const [name, descriptor] of resourceEntries) {
    const state = getServiceState(descriptor);
    if (!state || resourceNames.get(state) !== name) {
      continue;
    }

    resources[name] = compileService(name, state, resourceNames, diagnostics);
  }

  const parsed = parseProjectSpec({
    name: options.name,
    resources,
    schemaVersion: 1,
  });

  if (!parsed.success) {
    diagnostics.push(...parsed.diagnostics);
  }

  if (diagnostics.length > 0 || !parsed.success) {
    throw new ProjectDefinitionError(diagnostics);
  }

  const definition = Object.create(null) as ProjectDefinition;
  Object.defineProperty(definition, projectDefinitionSymbol, {
    value: deepFreeze(parsed.output),
  });
  return Object.freeze(definition);
}

export function readProjectDefinition(input: unknown): Result<ProjectSpec> {
  const spec = isObject(input) ? Reflect.get(input, projectDefinitionSymbol) : undefined;

  if (spec) {
    const parsed = parseProjectSpec(spec);
    return parsed.success ? { output: deepFreeze(parsed.output), success: true } : parsed;
  }

  return {
    diagnostics: [
      {
        code: "SYD1102",
        message: "The default export must be created by defineProject().",
        path: [],
      },
    ],
    success: false,
  };
}

function compileService(
  resourceName: string,
  state: ServiceState,
  resourceNames: ReadonlyMap<ServiceState, string>,
  diagnostics: Diagnostic[],
): ProcessResourceSpec {
  const endpoints: Record<string, ProcessResourceSpec["endpoints"][string]> = {};
  const endpointEnvironmentNames = new Map<string, string>();

  for (const [name, descriptor] of Object.entries(state.endpoints).sort(compareEntries)) {
    const endpointState = getEndpointState(descriptor);
    const path = ["resources", resourceName, "endpoints", name] as const;

    if (!endpointState) {
      diagnostics.push({
        code: "SYD1103",
        message: "Must be an endpoint created by endpoint.http().",
        path,
      });
      continue;
    }

    const previousEndpoint = endpointEnvironmentNames.get(endpointState.env);
    if (previousEndpoint) {
      diagnostics.push({
        code: "SYD1104",
        message: `Environment variable '${endpointState.env}' is already assigned to endpoint '${previousEndpoint}'.`,
        path: [...path, "port", "env"],
      });
    } else {
      endpointEnvironmentNames.set(endpointState.env, name);
    }

    endpoints[name] = {
      kind: "http",
      port: {
        env: endpointState.env,
        kind: "allocated",
        ...(endpointState.preferredPort === undefined
          ? {}
          : { preferred: endpointState.preferredPort }),
      },
    };
  }

  const env: Record<string, EnvironmentValueSpec> = {};

  for (const [name, value] of Object.entries(state.env).sort(compareEntries)) {
    if (endpointEnvironmentNames.has(name)) {
      diagnostics.push({
        code: "SYD1105",
        message: `Environment variable '${name}' is managed by an endpoint and cannot also be set explicitly.`,
        path: ["resources", resourceName, "env", name],
      });
      continue;
    }

    if (typeof value === "string") {
      env[name] = value;
      continue;
    }

    const expression = compileRuntimeValue(value, resourceNames, diagnostics, [
      "resources",
      resourceName,
      "env",
      name,
    ]);
    if (expression) {
      env[name] = expression;
    }
  }

  return {
    command: {
      args: state.command.slice(1),
      executable: state.command[0] ?? "",
    },
    cwd: state.cwd,
    endpoints,
    env,
    kind: "process",
  };
}

function compileRuntimeValue(
  value: unknown,
  resourceNames: ReadonlyMap<ServiceState, string>,
  diagnostics: Diagnostic[],
  path: readonly string[],
): EndpointValueExpression | undefined {
  const state = getRuntimeValueState(value);

  if (!state) {
    diagnostics.push({
      code: "SYD1106",
      message: "Must be a string or a Stackyard runtime value.",
      path,
    });
    return undefined;
  }

  const resource = resourceNames.get(state.service);
  if (!resource) {
    diagnostics.push({
      code: "SYD1107",
      message: "The referenced service is not registered in this project.",
      path,
    });
    return undefined;
  }

  if (!getEndpointState(state.service.endpoints[state.endpoint])) {
    diagnostics.push({
      code: "SYD1108",
      message: `The referenced endpoint '${state.endpoint}' is not valid.`,
      path,
    });
    return undefined;
  }

  return {
    endpoint: state.endpoint,
    kind: `endpoint-${state.field}`,
    resource,
  };
}

function compareEntries(
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown],
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (!isObject(value) || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
