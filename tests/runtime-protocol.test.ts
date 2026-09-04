import { expect, test } from "bun:test";

import { createDiagnostic, createDiagnosticReport } from "../packages/diagnostics/src/index.ts";
import {
  createResourceLogBatch,
  createProjectStartedMessage,
  createProjectList,
  createStartProjectMessage,
  parseDaemonClientMessage,
  parseDaemonServerMessage,
  parseProjectList,
  parseResourceLogBatch,
} from "../packages/protocol/src/index.ts";

test("project lists round-trip as immutable public state", () => {
  const projectList = createProjectList({
    projects: [
      {
        id: "project-1",
        name: "demo",
        restartRequired: false,
        root: "/project",
        services: [
          {
            endpoints: [{ name: "http", url: "http://127.0.0.1:4000" }],
            name: "api",
            startWithProject: true,
            state: "running",
          },
        ],
        state: "running",
      },
    ],
  });

  const parsed = parseProjectList(JSON.parse(JSON.stringify(projectList)));
  expect(parsed).toEqual({ output: projectList, success: true });
  expect(Object.isFrozen(projectList)).toBeTrue();
  expect(Object.isFrozen(projectList.projects[0]?.services[0]?.endpoints)).toBeTrue();
});

test("invalid project lists produce actionable protocol diagnostics", () => {
  const parsed = parseProjectList({ projects: "invalid", schemaVersion: 1 });

  expect(parsed.success).toBeFalse();
  if (!parsed.success) {
    expect(parsed.diagnostics[0].code).toBe("SYD1200");
    expect(parsed.diagnostics[0].help).toContain("client and daemon");
  }
});

test("project lists reject relative roots and duplicate durable identities", () => {
  const project = {
    id: "project-1",
    name: "demo",
    restartRequired: false,
    root: "/project-one",
    services: [],
    state: "stopped",
  } as const;

  expect(
    parseProjectList({
      projects: [{ ...project, root: "relative" }],
      schemaVersion: 1,
    }).success,
  ).toBeFalse();
  expect(
    parseProjectList({
      projects: [project, { ...project, root: "/project-two" }],
      schemaVersion: 1,
    }).success,
  ).toBeFalse();
  expect(
    parseProjectList({
      projects: [project, { ...project, id: "project-2" }],
      schemaVersion: 1,
    }).success,
  ).toBeFalse();
});

test("project start messages identify a project without duplicating its definition", () => {
  const message = createStartProjectMessage("/project", { COLOR: "1", TOKEN: "value" });

  const parsed = parseDaemonClientMessage(JSON.parse(JSON.stringify(message)));

  expect(parsed).toEqual({ output: message, success: true });
  expect(Object.isFrozen(message.environment)).toBeTrue();
  expect(message).not.toHaveProperty("spec");
});

test("project start messages reject non-string environment values", () => {
  const parsed = parseDaemonClientMessage({
    environment: { PORT: 4000 },
    kind: "start",
    root: "/project",
    schemaVersion: 1,
  });

  expect(parsed.success).toBeFalse();
  if (!parsed.success) {
    expect(parsed.diagnostics[0].code).toBe("SYD1200");
  }
});

test("project started messages round-trip and reject unknown properties", () => {
  const message = createProjectStartedMessage("project-1", "demo");

  expect(message).toEqual({
    kind: "started",
    projectId: "project-1",
    projectName: "demo",
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
