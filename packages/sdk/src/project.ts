import {
  createDiagnostic,
  DiagnosticCollector,
  DiagnosticError,
  failure,
  reportDiagnostics,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";
import {
  createProjectSpec,
  parseProjectSpec,
  type EndpointValueExpression,
  type EnvironmentValueSpec,
  type ProcessResourceSpec,
  type ProjectSpec,
} from "@stackyard/protocol";

import {
  getEndpointState,
  getRuntimeValueState,
  getServiceState,
  type ServiceDescriptor,
  type ServiceState,
} from "./descriptors.ts";

declare const projectDefinitionBrand: unique symbol;

const projectDefinitionSymbol: symbol = Symbol.for("stackyard.project-definition");

export interface ProjectDefinition {
  readonly [projectDefinitionBrand]: never;
}

export interface ProjectOptions<Resources extends ResourceInputRecord> {
  readonly name: string;
  readonly resources: Resources;
}

export type ResourceInputRecord = Readonly<Record<string, ServiceDescriptor>>;

export function defineProject<const Resources extends ResourceInputRecord>(
  options: ProjectOptions<Resources>,
): ProjectDefinition {
  const diagnostics = new DiagnosticCollector();
  const resourceNames = new Map<ServiceState, string>();
  const resourceEntries = Object.entries(options.resources).sort(compareEntries);

  for (const [name, descriptor] of resourceEntries) {
    const state = getServiceState(descriptor);

    if (!state) {
      diagnostics.report(
        createDiagnostic({
          code: "SYD1100",
          help: "Create the resource with service({...}) before registering it.",
          message: "Resource was not created by service().",
          path: ["resources", name],
        }),
      );
      continue;
    }

    const previousName = resourceNames.get(state);
    if (previousName) {
      diagnostics.report(
        createDiagnostic({
          code: "SYD1101",
          help: "Register each service() result once, or create a separate service descriptor.",
          message: `The same service is already registered as '${previousName}'.`,
          path: ["resources", name],
        }),
      );
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

  const created = createProjectSpec({
    name: options.name,
    resources,
  });

  if (!created.success) {
    reportDiagnostics(diagnostics, created.diagnostics);
  }

  const definitionFailure = diagnostics.toFailure();
  if (definitionFailure) {
    const [diagnostic, ...additionalDiagnostics] = definitionFailure.diagnostics;
    throw new DiagnosticError(diagnostic, ...additionalDiagnostics);
  }

  if (!created.success) {
    throw new Error("Project creation failed without a collected diagnostic.");
  }

  const definition = Object.create(null) as ProjectDefinition;
  Object.defineProperty(definition, projectDefinitionSymbol, {
    value: created.output,
  });
  return Object.freeze(definition);
}

export function readProjectDefinition(input: unknown): Result<ProjectSpec> {
  if (isObject(input) && Object.hasOwn(input, projectDefinitionSymbol)) {
    return parseProjectSpec(Reflect.get(input, projectDefinitionSymbol));
  }

  return failure(
    createDiagnostic({
      code: "SYD1102",
      help: "Export defineProject({...}) as the default from stackyard/main.ts.",
      message: "The default export was not created by defineProject().",
    }),
  );
}

function compileService(
  resourceName: string,
  state: ServiceState,
  resourceNames: ReadonlyMap<ServiceState, string>,
  diagnostics: DiagnosticSink,
): ProcessResourceSpec {
  const endpoints: Record<string, ProcessResourceSpec["endpoints"][string]> = {};

  for (const [name, descriptor] of Object.entries(state.endpoints).sort(compareEntries)) {
    const endpointState = getEndpointState(descriptor);
    const path = ["resources", resourceName, "endpoints", name] as const;

    if (!endpointState) {
      diagnostics.report(
        createDiagnostic({
          code: "SYD1103",
          help: "Create the endpoint with endpoint.http({...}) before registering it.",
          message: "Endpoint was not created by endpoint.http().",
          path,
        }),
      );
      continue;
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
    startWithProject: state.startWithProject,
  };
}

function compileRuntimeValue(
  value: unknown,
  resourceNames: ReadonlyMap<ServiceState, string>,
  diagnostics: DiagnosticSink,
  path: readonly string[],
): EndpointValueExpression | undefined {
  const state = getRuntimeValueState(value);

  if (!state) {
    diagnostics.report(
      createDiagnostic({
        code: "SYD1106",
        help: "Use a string or an endpoint .host, .port, or .url runtime value.",
        message: "Environment value is not a supported Stackyard runtime value.",
        path,
      }),
    );
    return undefined;
  }

  const resource = resourceNames.get(state.service);
  if (!resource) {
    diagnostics.report(
      createDiagnostic({
        code: "SYD1107",
        help: "Add the referenced service to this project's resources before using its endpoint.",
        message: "The referenced service is not registered in this project.",
        path,
      }),
    );
    return undefined;
  }

  if (!getEndpointState(state.service.endpoints[state.endpoint])) {
    diagnostics.report(
      createDiagnostic({
        code: "SYD1108",
        help: "Define the endpoint on the referenced service before using it.",
        message: `The referenced endpoint '${state.endpoint}' is not valid.`,
        path,
      }),
    );
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

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
