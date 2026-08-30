import * as z from "zod";

import {
  createDiagnostic,
  DiagnosticCollector,
  failure,
  success,
  type Diagnostic,
  type Failure,
  type Result,
} from "@stackyard/diagnostics";

const version = 1;
const projectNamePattern = /^[a-z][a-z0-9-]*$/;
const resourceNamePattern = /^[a-z][A-Za-z0-9-]*$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ProjectIssueContext = "record-key" | "value";

export interface EndpointSpec {
  readonly kind: "http";
  readonly port: {
    readonly env: string;
    readonly kind: "allocated";
    readonly preferred?: number | undefined;
  };
}

export interface EndpointValueExpression {
  readonly endpoint: string;
  readonly kind: "endpoint-host" | "endpoint-port" | "endpoint-url";
  readonly resource: string;
}

export type EnvironmentValueSpec = string | EndpointValueExpression;

export interface ProcessResourceSpec {
  readonly command: {
    readonly args: readonly string[];
    readonly executable: string;
  };
  readonly cwd: string;
  readonly endpoints: Readonly<Record<string, EndpointSpec>>;
  readonly env: Readonly<Record<string, EnvironmentValueSpec>>;
  readonly kind: "process";
}

export interface ProjectSpec {
  readonly name: string;
  readonly resources: Readonly<Record<string, ProcessResourceSpec>>;
  readonly schemaVersion: typeof version;
}

type ProjectSpecInput = Omit<ProjectSpec, "schemaVersion">;

const ProjectNameSchema = z
  .string({ error: "Project name must be a string." })
  .min(1, "Project name must not be empty.")
  .max(63, "Project name exceeds 63 characters.")
  .regex(projectNamePattern, "Project name contains unsupported characters.");

const ResourceNameSchema = z
  .string({ error: "Identifier must be a string." })
  .min(1, "Identifier must not be empty.")
  .max(63, "Identifier exceeds 63 characters.")
  .regex(resourceNamePattern, "Identifier contains unsupported characters.");

const EnvironmentNameSchema = z
  .string({ error: "Environment variable name must be a string." })
  .regex(environmentNamePattern, "Environment variable name is invalid.");

const RelativeDirectorySchema = z
  .string({ error: "Working directory must be a string." })
  .refine(
    isPortableRelativeDirectory,
    "Working directory is not a portable project-relative path.",
  );

const PortSchema = z
  .number({ error: "Port must be a number." })
  .int("Port must be an integer.")
  .min(1, "Port must be at least 1.")
  .max(65_535, "Port must be at most 65535.");

const EndpointValueExpressionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    endpoint: ResourceNameSchema,
    kind: z.literal("endpoint-host"),
    resource: ResourceNameSchema,
  }),
  z.strictObject({
    endpoint: ResourceNameSchema,
    kind: z.literal("endpoint-port"),
    resource: ResourceNameSchema,
  }),
  z.strictObject({
    endpoint: ResourceNameSchema,
    kind: z.literal("endpoint-url"),
    resource: ResourceNameSchema,
  }),
]);

const EnvironmentValueSchema = z.union([z.string(), EndpointValueExpressionSchema], {
  error: "Environment value must be a string or endpoint reference.",
});

const CommandSchema = z.strictObject({
  args: z.array(z.string()),
  executable: z
    .string({ error: "Command executable must be a string." })
    .min(1, "Command executable must not be empty."),
});

const HttpEndpointSchema = z.strictObject({
  kind: z.literal("http"),
  port: z.strictObject({
    env: EnvironmentNameSchema,
    kind: z.literal("allocated"),
    preferred: PortSchema.optional(),
  }),
});

const ProcessResourceSchema = z.strictObject({
  command: CommandSchema,
  cwd: RelativeDirectorySchema,
  endpoints: z.record(ResourceNameSchema, HttpEndpointSchema),
  env: z.record(EnvironmentNameSchema, EnvironmentValueSchema),
  kind: z.literal("process"),
});

const ProjectSpecSchema: z.ZodType<ProjectSpec> = z.strictObject({
  name: ProjectNameSchema,
  resources: z.record(ResourceNameSchema, ProcessResourceSchema),
  schemaVersion: z.literal(version),
});

export function createProjectSpec(input: ProjectSpecInput): Result<ProjectSpec> {
  return parseProjectSpec({ ...input, schemaVersion: version });
}

export function parseProjectSpec(input: unknown): Result<ProjectSpec> {
  const versionFailure = validateVersion(input);
  if (versionFailure) {
    return versionFailure;
  }

  const result = ProjectSpecSchema.safeParse(input);

  if (result.success) {
    return success(deepFreeze(result.data));
  }

  const diagnostics = new DiagnosticCollector();
  for (const issue of result.error.issues) {
    for (const diagnostic of issueToDiagnostics(issue)) {
      diagnostics.report(diagnostic);
    }
  }

  const parseFailure = diagnostics.toFailure();
  if (!parseFailure) {
    throw new Error("Project parsing failed without a diagnostic.");
  }

  return parseFailure;
}

function validateVersion(input: unknown): Failure | undefined {
  if (typeof input !== "object" || input === null || !Object.hasOwn(input, "schemaVersion")) {
    return failure(
      createDiagnostic({
        code: "SYD1008",
        help: "Regenerate the specification with the installed Stackyard package.",
        message: "Project specification schema version is missing.",
        path: ["schemaVersion"],
      }),
    );
  }

  const received = Reflect.get(input, "schemaVersion");
  if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 1) {
    return failure(
      createDiagnostic({
        code: "SYD1008",
        help: "Regenerate the specification with the installed Stackyard package.",
        message: "Project specification schema version must be a positive integer.",
        path: ["schemaVersion"],
      }),
    );
  }

  if (received !== version) {
    return failure(
      createDiagnostic({
        code: "SYD1008",
        help:
          received > version
            ? "Update Stackyard to a version that supports this project specification."
            : "Update the project's Stackyard package and regenerate the specification.",
        message: `Project specification schema version ${received} is not supported.`,
        notes: [`Supported schema version: ${version}.`],
        path: ["schemaVersion"],
      }),
    );
  }

  return undefined;
}

function issueToDiagnostics(
  issue: z.core.$ZodIssue,
  prefix: readonly (number | string)[] = [],
  context: ProjectIssueContext = "value",
): readonly Diagnostic[] {
  const path = [...prefix, ...issue.path.filter(isPathSegment)];

  if (issue.code === "invalid_key") {
    return issue.issues.flatMap((nestedIssue) =>
      issueToDiagnostics(nestedIssue, path, "record-key"),
    );
  }

  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) =>
      createDiagnostic({
        code: "SYD1001",
        help: "Remove the property or replace it with a supported property.",
        message: "Property is not recognized.",
        path: [...path, key],
      }),
    );
  }

  const details = classifyProjectIssue(path, context);
  return [
    createDiagnostic({
      code: details.code,
      ...(details.help ? { help: details.help } : {}),
      message: issue.message,
      path,
    }),
  ];
}

interface ProjectIssueDetails {
  readonly code: string;
  readonly help?: string;
}

function classifyProjectIssue(
  path: readonly (number | string)[],
  context: ProjectIssueContext,
): ProjectIssueDetails {
  const field = path[path.length - 1];
  const owner = path[path.length - 2];

  if (path.length === 1 && field === "name") {
    return {
      code: "SYD1002",
      help: "Use 1–63 lowercase letters, numbers, or hyphens, starting with a letter.",
    };
  }

  if (context === "record-key" && owner === "env") {
    return {
      code: "SYD1004",
      help: "Use letters, numbers, or underscores, starting with a letter or underscore.",
    };
  }

  if (isEnvironmentValuePath(path, context)) {
    return {
      code: "SYD1007",
      help: "Use a string or an endpoint .host, .port, or .url runtime value.",
    };
  }

  if (context === "record-key" || field === "endpoint" || field === "resource") {
    return {
      code: "SYD1003",
      help: "Use 1–63 letters, numbers, or hyphens, starting with a lowercase letter.",
    };
  }

  if (field === "env") {
    return {
      code: "SYD1004",
      help: "Use letters, numbers, or underscores, starting with a letter or underscore.",
    };
  }

  if (field === "cwd") {
    return {
      code: "SYD1005",
      help: 'Use a forward-slash path inside the project root, such as "apps/api".',
    };
  }

  if (field === "preferred") {
    return {
      code: "SYD1006",
      help: "Use an integer from 1 through 65535.",
    };
  }

  return { code: "SYD1000" };
}

function isEnvironmentValuePath(
  path: readonly (number | string)[],
  context: ProjectIssueContext,
): boolean {
  return context === "value" && path.length === 4 && path[0] === "resources" && path[2] === "env";
}

function isPathSegment(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function isPortableRelativeDirectory(value: string): boolean {
  if (value === ".") {
    return true;
  }

  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
