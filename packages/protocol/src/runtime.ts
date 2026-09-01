import {
  createDiagnostic,
  failure,
  isDiagnosticReport,
  success,
  type DiagnosticReport,
  type Result,
} from "@stackyard/diagnostics";

import { deepFreeze } from "./freeze.ts";
import { parseProjectSpec, type ProjectSpec } from "./project.ts";
import { protocolVersion } from "./version.ts";

export interface StartProjectMessage {
  readonly environment: Readonly<Record<string, string>>;
  readonly kind: "start";
  readonly root: string;
  readonly schemaVersion: typeof protocolVersion;
  readonly spec: ProjectSpec;
}

export interface StopProjectMessage {
  readonly kind: "stop";
  readonly schemaVersion: typeof protocolVersion;
}

export type DaemonClientMessage = StartProjectMessage | StopProjectMessage;

export interface ProjectStartedMessage {
  readonly kind: "started";
  readonly projectId: string;
  readonly schemaVersion: typeof protocolVersion;
}

export interface ProjectCompletedMessage {
  readonly exitCode: number;
  readonly kind: "completed";
  readonly schemaVersion: typeof protocolVersion;
}

export interface ProjectStoppedMessage {
  readonly kind: "stopped";
  readonly schemaVersion: typeof protocolVersion;
}

export interface DaemonFailureMessage {
  readonly kind: "failed";
  readonly report: DiagnosticReport;
  readonly schemaVersion: typeof protocolVersion;
}

export type DaemonServerMessage =
  | DaemonFailureMessage
  | ProjectCompletedMessage
  | ProjectStartedMessage
  | ProjectStoppedMessage;

export function createStartProjectMessage(
  root: string,
  spec: ProjectSpec,
  environment: Readonly<Record<string, string>>,
): StartProjectMessage {
  return deepFreeze({ environment, kind: "start", root, schemaVersion: protocolVersion, spec });
}

export function createStopProjectMessage(): StopProjectMessage {
  return Object.freeze({ kind: "stop", schemaVersion: protocolVersion });
}

export function createProjectStartedMessage(projectId: string): ProjectStartedMessage {
  return Object.freeze({
    kind: "started",
    projectId,
    schemaVersion: protocolVersion,
  });
}

export function createProjectCompletedMessage(exitCode: number): ProjectCompletedMessage {
  return Object.freeze({ exitCode, kind: "completed", schemaVersion: protocolVersion });
}

export function createProjectStoppedMessage(): ProjectStoppedMessage {
  return Object.freeze({ kind: "stopped", schemaVersion: protocolVersion });
}

export function createDaemonFailureMessage(report: DiagnosticReport): DaemonFailureMessage {
  return deepFreeze({ kind: "failed", report, schemaVersion: protocolVersion });
}

export function parseDaemonClientMessage(input: unknown): Result<DaemonClientMessage> {
  const envelope = parseEnvelope(input);
  if (!envelope.success) {
    return envelope;
  }

  if (envelope.output.kind === "stop") {
    if (Object.keys(envelope.output).length !== 2) {
      return invalidMessage("Daemon stop message contains unsupported properties.");
    }
    return success(createStopProjectMessage());
  }

  if (envelope.output.kind !== "start") {
    return invalidMessage("Daemon client message kind is not supported.");
  }

  if (
    Object.keys(envelope.output).length !== 5 ||
    typeof envelope.output.root !== "string" ||
    envelope.output.root.length === 0 ||
    !isStringRecord(envelope.output.environment)
  ) {
    return invalidMessage("Daemon start message is invalid.");
  }

  const spec = parseProjectSpec(envelope.output.spec);
  if (!spec.success) {
    return spec;
  }

  return success(
    createStartProjectMessage(envelope.output.root, spec.output, envelope.output.environment),
  );
}

export function parseDaemonServerMessage(input: unknown): Result<DaemonServerMessage> {
  const envelope = parseEnvelope(input);
  if (!envelope.success) {
    return envelope;
  }

  const value = envelope.output;
  if (value.kind === "started") {
    if (
      Object.keys(value).length === 3 &&
      typeof value.projectId === "string" &&
      value.projectId.length > 0
    ) {
      return success(createProjectStartedMessage(value.projectId));
    }
  } else if (value.kind === "completed") {
    if (
      Object.keys(value).length === 3 &&
      typeof value.exitCode === "number" &&
      Number.isSafeInteger(value.exitCode)
    ) {
      return success(createProjectCompletedMessage(value.exitCode));
    }
  } else if (value.kind === "stopped" && Object.keys(value).length === 2) {
    return success(createProjectStoppedMessage());
  } else if (
    value.kind === "failed" &&
    Object.keys(value).length === 3 &&
    isDiagnosticReport(value.report)
  ) {
    return success(createDaemonFailureMessage(value.report));
  }

  return invalidMessage("Daemon server message is invalid.");
}

function parseEnvelope(input: unknown): Result<Record<string, unknown> & { kind: string }> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.get(input, "schemaVersion") !== protocolVersion ||
    typeof Reflect.get(input, "kind") !== "string"
  ) {
    return invalidMessage("Daemon protocol envelope is invalid.");
  }

  const kind = Reflect.get(input, "kind");
  if (typeof kind !== "string") {
    throw new Error("Validated daemon message kind is not a string.");
  }
  return success({ ...input, kind });
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(([name, entry]) => name.length > 0 && typeof entry === "string")
  );
}

function invalidMessage<T>(message: string, note?: string): Result<T> {
  if (note) {
    return failure(
      createDiagnostic({
        code: "SYD1200",
        help: "Update Stackyard so the CLI and daemon use the same protocol, then retry.",
        message,
        notes: [note],
      }),
    );
  }
  return failure(
    createDiagnostic({
      code: "SYD1200",
      help: "Update Stackyard so the CLI and daemon use the same protocol, then retry.",
      message,
    }),
  );
}
