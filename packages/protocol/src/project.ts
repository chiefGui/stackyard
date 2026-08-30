import * as z from "zod";

import {
  createDiagnostic,
  DiagnosticCollector,
  success,
  type Diagnostic,
  type Result,
} from "@stackyard/diagnostics";

const projectNamePattern = /^[a-z][a-z0-9-]*$/;
const resourceNamePattern = /^[a-z][A-Za-z0-9-]*$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ProjectIssueContext = "record-key" | "value";

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

export const ProjectSpecSchema = z.strictObject({
  name: ProjectNameSchema,
  resources: z.record(ResourceNameSchema, ProcessResourceSchema),
  schemaVersion: z.literal(1),
});

type MutableProjectSpec = z.output<typeof ProjectSpecSchema>;

export type ProjectSpec = DeepReadonly<MutableProjectSpec>;
export type ProcessResourceSpec = ProjectSpec["resources"][string];
export type EndpointSpec = ProcessResourceSpec["endpoints"][string];
export type EnvironmentValueSpec = ProcessResourceSpec["env"][string];
export type EndpointValueExpression = Exclude<EnvironmentValueSpec, string>;

export function parseProjectSpec(input: unknown): Result<ProjectSpec> {
  const result = ProjectSpecSchema.safeParse(input);

  if (result.success) {
    return success(result.data);
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

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;
