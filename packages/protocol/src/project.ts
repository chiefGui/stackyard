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

const ProjectNameSchema = z
  .string()
  .min(1, "Must not be empty.")
  .max(63, "Must contain at most 63 characters.")
  .regex(
    projectNamePattern,
    "Must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.",
  );

const ResourceNameSchema = z
  .string()
  .min(1, "Must not be empty.")
  .max(63, "Must contain at most 63 characters.")
  .regex(
    resourceNamePattern,
    "Must start with a lowercase letter and contain only letters, numbers, and hyphens.",
  );

const EnvironmentNameSchema = z
  .string()
  .regex(environmentNamePattern, "Must be a valid environment variable name.");

const RelativeDirectorySchema = z
  .string()
  .refine(isPortableRelativeDirectory, "Must be a portable path inside the project root.");

const PortSchema = z
  .number()
  .int("Must be an integer.")
  .min(1, "Must be at least 1.")
  .max(65_535, "Must be at most 65535.");

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
  error: "Must be a string or endpoint reference.",
});

const CommandSchema = z.strictObject({
  args: z.array(z.string()),
  executable: z.string().min(1, "Must not be empty."),
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
): readonly Diagnostic[] {
  const path = [...prefix, ...issue.path.filter(isPathSegment)];

  if (issue.code === "invalid_key") {
    return issue.issues.flatMap((nestedIssue) => issueToDiagnostics(nestedIssue, path));
  }

  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) =>
      createDiagnostic("SYD1000", "Property is not recognized.", {
        path: [...path, key],
      }),
    );
  }

  return [createDiagnostic("SYD1000", issue.message, { path })];
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
