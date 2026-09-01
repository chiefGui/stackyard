import { expect, test } from "bun:test";

import {
  createProjectStartedMessage,
  createProjectSpec,
  createRuntimeSnapshot,
  createStartProjectMessage,
  parseDaemonClientMessage,
  parseDaemonServerMessage,
  parseRuntimeSnapshot,
} from "../packages/protocol/src/index.ts";

test("runtime snapshots round-trip as immutable public state", () => {
  const snapshot = createRuntimeSnapshot({
    projects: [
      {
        id: "project-1",
        name: "demo",
        resources: [
          {
            endpoints: [{ name: "http", url: "http://127.0.0.1:4000" }],
            name: "api",
            state: "running",
          },
        ],
      },
    ],
    revision: 3,
  });

  const parsed = parseRuntimeSnapshot(JSON.parse(JSON.stringify(snapshot)));
  expect(parsed).toEqual({ output: snapshot, success: true });
  expect(Object.isFrozen(snapshot)).toBeTrue();
  expect(Object.isFrozen(snapshot.projects[0]?.resources[0]?.endpoints)).toBeTrue();
});

test("invalid runtime snapshots produce actionable protocol diagnostics", () => {
  const parsed = parseRuntimeSnapshot({ projects: [], revision: -1, schemaVersion: 1 });

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
