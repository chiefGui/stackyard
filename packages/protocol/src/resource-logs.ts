import {
  createDiagnostic,
  failure,
  isDiagnosticReport,
  success,
  type DiagnosticReport,
  type Result,
} from "@stackyard/diagnostics";

import { deepFreeze } from "./freeze.ts";
import { protocolVersion } from "./version.ts";

export type ResourceLogStream = "stderr" | "stdout" | "system";
export type ResourceLogStatus = "complete" | "failed" | "live" | "removed";

export interface ResourceLogEntry {
  readonly observedAt: number;
  readonly sequence: number;
  readonly stream: ResourceLogStream;
  readonly text: string;
  readonly truncatedBytes?: number;
}

interface ResourceLogBatchBase {
  readonly cursor: number;
  readonly droppedEntries: number;
  readonly entries: readonly ResourceLogEntry[];
  readonly kind: "resource-log-batch";
  readonly latestCursor: number;
  readonly projectId: string;
  readonly resourceName: string;
  readonly retainedFrom: number;
  readonly schemaVersion: typeof protocolVersion;
}

export type ResourceLogBatch = ResourceLogBatchBase &
  (
    | { readonly failure: DiagnosticReport; readonly status: "failed" }
    | {
        readonly failure?: never;
        readonly status: Exclude<ResourceLogStatus, "failed">;
      }
  );

type ResourceLogBatchBaseInput = Omit<ResourceLogBatchBase, "kind" | "schemaVersion">;

export type ResourceLogBatchInput = ResourceLogBatchBaseInput &
  (
    | { readonly failure: DiagnosticReport; readonly status: "failed" }
    | {
        readonly failure?: never;
        readonly status: Exclude<ResourceLogStatus, "failed">;
      }
  );

export function createResourceLogBatch(input: ResourceLogBatchInput): ResourceLogBatch {
  const batch = {
    cursor: input.cursor,
    droppedEntries: input.droppedEntries,
    entries: input.entries,
    kind: "resource-log-batch",
    latestCursor: input.latestCursor,
    projectId: input.projectId,
    resourceName: input.resourceName,
    retainedFrom: input.retainedFrom,
    schemaVersion: protocolVersion,
  } as const;
  return input.status === "failed"
    ? deepFreeze({ ...batch, failure: input.failure, status: "failed" })
    : deepFreeze({ ...batch, status: input.status });
}

export function parseResourceLogBatch(input: unknown): Result<ResourceLogBatch> {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(
      input,
      [
        "cursor",
        "droppedEntries",
        "entries",
        "kind",
        "latestCursor",
        "projectId",
        "resourceName",
        "retainedFrom",
        "schemaVersion",
        "status",
      ],
      ["failure"],
    ) ||
    input.kind !== "resource-log-batch" ||
    input.schemaVersion !== protocolVersion ||
    !isNonNegativeSafeInteger(input.cursor) ||
    !isNonNegativeSafeInteger(input.droppedEntries) ||
    !isNonNegativeSafeInteger(input.latestCursor) ||
    !isPositiveSafeInteger(input.retainedFrom) ||
    input.cursor > input.latestCursor ||
    input.cursor < input.retainedFrom - 1 ||
    input.retainedFrom > input.latestCursor + 1 ||
    !isNonEmptyString(input.projectId) ||
    !isNonEmptyString(input.resourceName) ||
    !isResourceLogStatus(input.status) ||
    !Array.isArray(input.entries)
  ) {
    return invalidResourceLogBatch();
  }

  const entries = parseEntries(input.entries, input.retainedFrom, input.latestCursor, input.cursor);
  if (!entries) {
    return invalidResourceLogBatch();
  }

  const batch = {
    cursor: input.cursor,
    droppedEntries: input.droppedEntries,
    entries,
    latestCursor: input.latestCursor,
    projectId: input.projectId,
    resourceName: input.resourceName,
    retainedFrom: input.retainedFrom,
  };
  if (input.status === "failed") {
    if (!isDiagnosticReport(input.failure)) {
      return invalidResourceLogBatch();
    }
    return success(createResourceLogBatch({ ...batch, failure: input.failure, status: "failed" }));
  }
  if (input.failure !== undefined) {
    return invalidResourceLogBatch();
  }
  return success(createResourceLogBatch({ ...batch, status: input.status }));
}

function parseEntries(
  input: readonly unknown[],
  retainedFrom: number,
  latestCursor: number,
  cursor: number,
): ResourceLogEntry[] | undefined {
  const entries: ResourceLogEntry[] = [];
  let previousSequence = 0;
  for (const entry of input) {
    const parsed = parseEntry(entry);
    if (
      !parsed ||
      parsed.sequence <= previousSequence ||
      parsed.sequence < retainedFrom ||
      parsed.sequence > latestCursor
    ) {
      return undefined;
    }
    previousSequence = parsed.sequence;
    entries.push(parsed);
  }
  return entries.length === 0 || previousSequence === cursor ? entries : undefined;
}

function parseEntry(input: unknown): ResourceLogEntry | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["observedAt", "sequence", "stream", "text"], ["truncatedBytes"]) ||
    !isNonNegativeSafeInteger(input.observedAt) ||
    !isPositiveSafeInteger(input.sequence) ||
    !isResourceLogStream(input.stream) ||
    typeof input.text !== "string" ||
    (input.truncatedBytes !== undefined && !isPositiveSafeInteger(input.truncatedBytes))
  ) {
    return undefined;
  }
  return {
    observedAt: input.observedAt,
    sequence: input.sequence,
    stream: input.stream,
    text: input.text,
    ...(input.truncatedBytes === undefined ? {} : { truncatedBytes: input.truncatedBytes }),
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isResourceLogStatus(value: unknown): value is ResourceLogStatus {
  return value === "complete" || value === "failed" || value === "live" || value === "removed";
}

function isResourceLogStream(value: unknown): value is ResourceLogStream {
  return value === "stderr" || value === "stdout" || value === "system";
}

function invalidResourceLogBatch(): Result<ResourceLogBatch> {
  return failure(
    createDiagnostic({
      code: "SYD1200",
      help: "Update Stackyard so the dashboard and daemon use the same protocol, then retry.",
      message: "Resource log batch is invalid.",
    }),
  );
}
