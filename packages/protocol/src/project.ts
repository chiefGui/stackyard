import * as v from "valibot";

import type { Diagnostic, Result } from "./diagnostics.ts";

const projectNamePattern = /^[a-z][a-z0-9-]*$/;
const resourceNamePattern = /^[a-z][A-Za-z0-9-]*$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ProjectNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Must not be empty."),
  v.maxLength(63, "Must contain at most 63 characters."),
  v.regex(
    projectNamePattern,
    "Must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.",
  ),
);

const ResourceNameSchema = v.pipe(
  v.string(),
  v.minLength(1, "Must not be empty."),
  v.maxLength(63, "Must contain at most 63 characters."),
  v.regex(
    resourceNamePattern,
    "Must start with a lowercase letter and contain only letters, numbers, and hyphens.",
  ),
);

const EnvironmentNameSchema = v.pipe(
  v.string(),
  v.regex(environmentNamePattern, "Must be a valid environment variable name."),
);

const RelativeDirectorySchema = v.pipe(
  v.string(),
  v.check(isPortableRelativeDirectory, "Must be a portable path inside the project root."),
);

const PortSchema = v.pipe(
  v.number(),
  v.integer("Must be an integer."),
  v.minValue(1, "Must be at least 1."),
  v.maxValue(65_535, "Must be at most 65535."),
);

const EndpointValueExpressionSchema = v.variant("kind", [
  v.strictObject({
    endpoint: ResourceNameSchema,
    kind: v.literal("endpoint-host"),
    resource: ResourceNameSchema,
  }),
  v.strictObject({
    endpoint: ResourceNameSchema,
    kind: v.literal("endpoint-port"),
    resource: ResourceNameSchema,
  }),
  v.strictObject({
    endpoint: ResourceNameSchema,
    kind: v.literal("endpoint-url"),
    resource: ResourceNameSchema,
  }),
]);

const EnvironmentValueSchema = v.union([v.string(), EndpointValueExpressionSchema]);

const CommandSchema = v.strictObject({
  args: v.array(v.string()),
  executable: v.pipe(v.string(), v.minLength(1, "Must not be empty.")),
});

const HttpEndpointSchema = v.strictObject({
  kind: v.literal("http"),
  port: v.strictObject({
    env: EnvironmentNameSchema,
    kind: v.literal("allocated"),
    preferred: v.optional(PortSchema),
  }),
});

const ProcessResourceSchema = v.strictObject({
  command: CommandSchema,
  cwd: RelativeDirectorySchema,
  endpoints: v.record(ResourceNameSchema, HttpEndpointSchema),
  env: v.record(EnvironmentNameSchema, EnvironmentValueSchema),
  kind: v.literal("process"),
});

export const ProjectSpecSchema = v.strictObject({
  name: ProjectNameSchema,
  resources: v.record(ResourceNameSchema, ProcessResourceSchema),
  schemaVersion: v.literal(1),
});

type MutableProjectSpec = v.InferOutput<typeof ProjectSpecSchema>;

export type ProjectSpec = DeepReadonly<MutableProjectSpec>;
export type ProcessResourceSpec = ProjectSpec["resources"][string];
export type EndpointSpec = ProcessResourceSpec["endpoints"][string];
export type EnvironmentValueSpec = ProcessResourceSpec["env"][string];
export type EndpointValueExpression = Exclude<EnvironmentValueSpec, string>;

export function parseProjectSpec(input: unknown): Result<ProjectSpec> {
  const result = v.safeParse(ProjectSpecSchema, input, { abortEarly: false });

  if (result.success) {
    return { output: result.output, success: true };
  }

  return {
    diagnostics: result.issues.map(issueToDiagnostic),
    success: false,
  };
}

function issueToDiagnostic(issue: v.BaseIssue<unknown>): Diagnostic {
  return {
    code: "SYD1000",
    message: issue.message,
    path: issue.path?.map((item) => item.key).filter(isPathSegment) ?? [],
  };
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
