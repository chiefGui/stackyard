import { afterEach, describe, expect, test } from "bun:test";

import { startControlServer, type ControlData } from "../apps/daemon/src/server.ts";
import {
  ProjectManager,
  type PortAllocator,
  type ProcessExit,
  type ProcessHandle,
  type ProcessHost,
  type ProcessLogLine,
  type ProcessStart,
} from "../packages/control-plane/src/index.ts";
import { success } from "../packages/diagnostics/src/index.ts";
import {
  createProjectSpec,
  parseProjectList,
  parseResourceLogBatch,
  type ResourceLogBatch,
} from "../packages/protocol/src/index.ts";

/* oxlint-disable eslint/no-await-in-loop -- Stream frames and condition checks are sequential. */

const servers: Bun.Server<ControlData>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

describe("resource log HTTP API", () => {
  test("streams authenticated live logs and resumes completed history by cursor", async () => {
    const processes = new TestProcesses();
    const manager = new ProjectManager({
      ports: new NoPorts(),
      processes,
    });
    const startedProject = await manager.start({
      environment: {},
      environmentNamesCaseInsensitive: true,
      id: "project-1",
      revision: 1,
      root: "C:/project",
      spec: projectSpec(),
    });
    if (!startedProject.success) {
      throw new Error("Expected the project to start.");
    }
    processes.write({ observedAt: 10, stream: "stdout", text: "ready" });

    const startedServer = startControlServer({
      diagnostics: { report() {} },
      instanceId: "test-daemon",
      isShuttingDown: () => false,
      manager,
      onClose() {},
      onOpen() {},
      port: 0,
      token: "test-token",
    });
    if (!startedServer.success) {
      throw new Error("Expected the daemon server to start.");
    }
    const server = startedServer.output;
    servers.push(server);
    const logsUrl = new URL("/api/v1/projects/project-1/resources/api/logs", server.url);

    const unauthorized = await fetch(logsUrl);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const malformed = await fetch(new URL(`${logsUrl.href}?after=01`), authorized());
    expect(malformed.status).toBe(400);
    const ahead = await fetch(new URL(`${logsUrl.href}?after=2`), authorized());
    expect(ahead.status).toBe(400);
    const missing = await fetch(
      new URL("/api/v1/projects/project-1/resources/missing/logs", server.url),
      authorized(),
    );
    expect(missing.status).toBe(404);

    const response = await fetch(logsUrl, authorized());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const frames = new NdjsonFrames(response);
    expect(await frames.next()).toMatchObject({
      cursor: 1,
      entries: [{ sequence: 1, stream: "stdout", text: "ready" }],
      projectId: "project-1",
      resourceName: "api",
      status: "live",
    });

    processes.write({ observedAt: 11, stream: "stderr", text: "warning" });
    expect(await frames.next()).toMatchObject({
      cursor: 2,
      entries: [{ sequence: 2, stream: "stderr", text: "warning" }],
      status: "live",
    });

    await frames.cancel();

    const continuedResponse = await fetch(new URL(`${logsUrl.href}?after=2`), authorized());
    const continued = new NdjsonFrames(continuedResponse);
    expect(await continued.next()).toMatchObject({ cursor: 2, entries: [], status: "live" });

    expect((await startedProject.output.stop()).success).toBeTrue();
    expect(await continued.next()).toMatchObject({ cursor: 2, entries: [], status: "complete" });
    expect(await continued.done()).toBeTrue();

    const recentResponse = await fetch(
      new URL("/api/v1/projects/recent", server.url),
      authorized(),
    );
    const recent = parseProjectList(await recentResponse.json());
    expect(recent).toMatchObject({
      output: { projects: [{ id: "project-1", name: "demo" }] },
      success: true,
    });

    const resumedResponse = await fetch(new URL(`${logsUrl.href}?after=2`), authorized());
    const resumed = new NdjsonFrames(resumedResponse);
    expect(await resumed.next()).toMatchObject({
      cursor: 2,
      entries: [],
      status: "complete",
    });
    expect(await resumed.done()).toBeTrue();
  });
});

function authorized(): RequestInit {
  return { headers: { authorization: "Bearer test-token" } };
}

function projectSpec() {
  const created = createProjectSpec({
    name: "demo",
    resources: {
      api: {
        command: { args: ["dev"], executable: "bun" },
        cwd: ".",
        endpoints: {},
        env: {},
        kind: "process",
      },
    },
  });
  if (!created.success) {
    throw new Error("Expected a valid project specification.");
  }
  return created.output;
}

class NoPorts implements PortAllocator {
  async reserve(): Promise<never> {
    throw new Error("This test project does not allocate ports.");
  }
}

class TestProcesses implements ProcessHost {
  #start: ProcessStart | undefined;
  readonly handle = new TestHandle();

  async start(input: ProcessStart) {
    this.#start = input;
    return success<ProcessHandle>(this.handle);
  }

  write(...entries: ProcessLogLine[]): void {
    if (!this.#start) {
      throw new Error("Expected the process to be started.");
    }
    this.#start.logs.write(entries);
  }
}

class TestHandle implements ProcessHandle {
  readonly exited: Promise<ProcessExit>;
  readonly leaderExited: Promise<number>;
  readonly pid = 100;
  #exit!: (exit: ProcessExit) => void;
  #leaderExit!: (exitCode: number) => void;
  #stopped = false;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.#exit = resolve;
    });
    this.leaderExited = new Promise((resolve) => {
      this.#leaderExit = resolve;
    });
  }

  async stop() {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#leaderExit(0);
      this.#exit({ cleanup: success(undefined), exitCode: 0, logCapture: success(undefined) });
    }
    return success(undefined);
  }
}

class NdjsonFrames {
  readonly #decoder = new TextDecoder();
  readonly #reader: ByteStreamReader;
  #buffer = "";

  constructor(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected a streaming response body.");
    }
    this.#reader = reader;
  }

  async next(): Promise<ResourceLogBatch> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const parsed = parseResourceLogBatch(JSON.parse(line));
        if (!parsed.success) {
          throw new Error("Expected a valid resource log frame.");
        }
        return parsed.output;
      }

      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("Resource log stream ended before its next frame.");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async done(): Promise<boolean> {
    const chunk = await this.#reader.read();
    if (!chunk.done) {
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
    return chunk.done;
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

interface ByteStreamReader {
  cancel(): Promise<void>;
  read(): Promise<ByteStreamReadResult>;
}

type ByteStreamReadResult =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: undefined };
