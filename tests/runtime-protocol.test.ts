import { expect, test } from "bun:test";

import { createDiagnostic, createDiagnosticReport } from "../packages/diagnostics/src/index.ts";
import {
  createResourceLogBatch,
  createProjectStartedMessage,
  createProjectSpec,
  createProjectList,
  createRegisteredProjectList,
  createStartProjectMessage,
  parseDaemonClientMessage,
  parseDaemonServerMessage,
  parseProjectList,
  parseRegisteredProjectList,
  parseResourceLogBatch,
} from "../packages/protocol/src/index.ts";

test("project lists round-trip as immutable public state", () => {
  const projectList = createProjectList({
    projects: [
      {
        id: "project-1",
        name: "demo",
        services: [
          {
            endpoints: [{ name: "http", url: "http://127.0.0.1:4000" }],
            name: "api",
            state: "running",
          },
        ],
      },
    ],
  });

  const parsed = parseProjectList(JSON.parse(JSON.stringify(projectList)));
  expect(parsed).toEqual({ output: projectList, success: true });
  expect(Object.isFrozen(projectList)).toBeTrue();
  expect(Object.isFrozen(projectList.projects[0]?.services[0]?.endpoints)).toBeTrue();
});

test("registered projects round-trip with their evaluated definitions", () => {
  const list = createRegisteredProjectList([
    {
      definition: { kind: "valid", spec: projectSpec() },
      id: "registration-1",
      root: "/project",
    },
  ]);

  const parsed = parseRegisteredProjectList(JSON.parse(JSON.stringify(list)));

  expect(parsed).toEqual({ output: list, success: true });
  expect(list.schemaVersion).toBe(1);
  expect(Object.isFrozen(list.projects[0]?.definition)).toBeTrue();
});

test("registered project lists reject unsupported schema versions", () => {
  const parsed = parseRegisteredProjectList({ projects: [], schemaVersion: 2 });

  expect(parsed.success).toBeFalse();
  if (!parsed.success) {
    expect(parsed.diagnostics[0].code).toBe("SYD1201");
  }
});

test("registered project lists reject relative roots and duplicate registrations", () => {
  const definition = { kind: "valid" as const, spec: projectSpec() };
  const relative = parseRegisteredProjectList({
    projects: [{ definition, id: "registration-1", root: "project" }],
    schemaVersion: 1,
  });
  const duplicate = parseRegisteredProjectList({
    projects: [
      { definition, id: "registration-1", root: "/project-one" },
      { definition, id: "registration-1", root: "/project-two" },
    ],
    schemaVersion: 1,
  });
  const duplicateRoot = parseRegisteredProjectList({
    projects: [
      { definition, id: "registration-1", root: "/project" },
      { definition, id: "registration-2", root: "/project" },
    ],
    schemaVersion: 1,
  });

  expect(relative.success).toBeFalse();
  expect(duplicate.success).toBeFalse();
  expect(duplicateRoot.success).toBeFalse();
});

test("invalid project lists produce actionable protocol diagnostics", () => {
  const parsed = parseProjectList({ projects: "invalid", schemaVersion: 1 });

  expect(parsed.success).toBeFalse();
  if (!parsed.success) {
    expect(parsed.diagnostics[0].code).toBe("SYD1200");
    expect(parsed.diagnostics[0].help).toContain("dashboard and daemon");
  }
});

test("project start messages carry an isolated service environment", () => {
  const spec = projectSpec();
  const message = createStartProjectMessage("/project", spec, { COLOR: "1", TOKEN: "value" });

  const parsed = parseDaemonClientMessage(JSON.parse(JSON.stringify(message)));

  expect(parsed).toEqual({ output: message, success: true });
  expect(Object.isFrozen(message.environment)).toBeTrue();
});

test("project start messages reject non-string environment values", () => {
  const parsed = parseDaemonClientMessage({
    environment: { PORT: 4000 },
    kind: "start",
    root: "/project",
    schemaVersion: 1,
    spec: projectSpec(),
  });

  expect(parsed.success).toBeFalse();
  if (!parsed.success) {
    expect(parsed.diagnostics[0].code).toBe("SYD1200");
  }
});

test("project started messages round-trip and reject unknown properties", () => {
  const message = createProjectStartedMessage("project-1");

  expect(message).toEqual({
    kind: "started",
    projectId: "project-1",
    schemaVersion: 1,
  });
  expect(parseDaemonServerMessage(JSON.parse(JSON.stringify(message)))).toEqual({
    output: message,
    success: true,
  });
  expect(
    parseDaemonServerMessage({ ...message, dashboardUrl: "http://127.0.0.1:3000" }).success,
  ).toBeFalse();
});

test("resource log batches round-trip as immutable resumable state", () => {
  const batch = createResourceLogBatch({
    cursor: 3,
    droppedEntries: 1,
    entries: [
      { observedAt: 10, sequence: 2, stream: "stdout", text: "ready" },
      {
        observedAt: 11,
        sequence: 3,
        stream: "stderr",
        text: "partial",
        truncatedBytes: 12,
      },
    ],
    latestCursor: 3,
    projectId: "project-1",
    resourceName: "api",
    retainedFrom: 2,
    status: "live",
  });

  const parsed = parseResourceLogBatch(JSON.parse(JSON.stringify(batch)));

  expect(parsed).toEqual({ output: batch, success: true });
  expect(Object.isFrozen(batch)).toBeTrue();
  expect(Object.isFrozen(batch.entries)).toBeTrue();
});

test("failed resource log batches carry their terminal diagnostic", () => {
  const failure = createDiagnosticReport([
    createDiagnostic({ code: "SYD3000", help: "Retry.", message: "Process failed." }),
  ]);
  const batch = createResourceLogBatch({
    cursor: 0,
    droppedEntries: 0,
    entries: [],
    failure,
    latestCursor: 0,
    projectId: "project-1",
    resourceName: "api",
    retainedFrom: 1,
    status: "failed",
  });

  expect(parseResourceLogBatch(JSON.parse(JSON.stringify(batch)))).toEqual({
    output: batch,
    success: true,
  });
  expect(parseResourceLogBatch({ ...batch, failure: undefined }).success).toBeFalse();
  expect(parseResourceLogBatch({ ...batch, status: "complete" }).success).toBeFalse();
  expect(parseResourceLogBatch({ ...batch, cursor: 1, latestCursor: 1 }).success).toBeTrue();
});

test("resource log batches reject ambiguous cursors and unsupported properties", () => {
  const batch = createResourceLogBatch({
    cursor: 2,
    droppedEntries: 0,
    entries: [{ observedAt: 10, sequence: 2, stream: "system", text: "started" }],
    latestCursor: 2,
    projectId: "project-1",
    resourceName: "api",
    retainedFrom: 1,
    status: "complete",
  });

  expect(parseResourceLogBatch({ ...batch, cursor: 1 }).success).toBeFalse();
  expect(parseResourceLogBatch({ ...batch, retainedFrom: 3 }).success).toBeFalse();
  expect(parseResourceLogBatch({ ...batch, heartbeat: true }).success).toBeFalse();
  expect(
    parseResourceLogBatch({ ...batch, entries: [{ ...batch.entries[0], sequence: 0 }] }).success,
  ).toBeFalse();
});

function projectSpec() {
  const created = createProjectSpec({
    name: "demo",
    resources: {
      api: {
        command: { args: [], executable: "bun" },
        cwd: ".",
        endpoints: {},
        env: {},
        kind: "process",
      },
    },
  });
  if (!created.success) {
    throw new Error("Test project specification is invalid.");
  }
  return created.output;
}
