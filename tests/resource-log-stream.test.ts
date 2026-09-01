import { describe, expect, test } from "bun:test";

import { createResourceLogResponse } from "../apps/daemon/src/resource-log-http.ts";
import { ResourceLogStore } from "../packages/control-plane/src/index.ts";
import { createDiagnostic, failure } from "../packages/diagnostics/src/index.ts";
import { parseResourceLogBatch, type ResourceLogBatch } from "../packages/protocol/src/index.ts";

describe("resource log stream", () => {
  test("batches a terminal feed without buffering the full history", async () => {
    const feed = new ResourceLogStore({
      maxBytesPerResource: 100_000,
      maxEntriesPerResource: 1_000,
    }).createFeed();
    feed.write(
      Array.from({ length: 300 }, (_, index) => ({
        observedAt: index,
        stream: "stdout" as const,
        text: `line-${index + 1}`,
      })),
    );
    feed.complete();
    let closes = 0;

    const response = createResourceLogResponse({
      after: 0,
      onClose: () => {
        closes += 1;
      },
      projectId: "project-1",
      resourceName: "api",
      signal: new AbortController().signal,
      source: feed,
    });
    const batches = await readAllBatches(response);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({
      cursor: 256,
      droppedEntries: 0,
      status: "complete",
    });
    expect(batches[0]?.entries).toHaveLength(256);
    expect(batches[1]).toMatchObject({ cursor: 300, status: "complete" });
    expect(batches[1]?.entries).toHaveLength(44);
    expect(closes).toBe(1);
  });

  test("publishes live changes and closes a waiting read on cancellation", async () => {
    const feed = new ResourceLogStore().createFeed();
    let closes = 0;
    const response = createResourceLogResponse({
      after: 0,
      onClose: () => {
        closes += 1;
      },
      projectId: "project-1",
      resourceName: "api",
      signal: new AbortController().signal,
      source: feed,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected a response body.");
    }

    expect(parseChunk(await reader.read())).toMatchObject({
      cursor: 0,
      entries: [],
      status: "live",
    });
    const next = reader.read();
    feed.write([{ observedAt: 10, stream: "stderr", text: "warning" }]);
    expect(parseChunk(await next)).toMatchObject({
      cursor: 1,
      entries: [{ sequence: 1, stream: "stderr", text: "warning" }],
      status: "live",
    });

    await reader.cancel();
    expect(closes).toBe(1);
  });

  test("reports an evicted gap once and advances past it", async () => {
    const store = new ResourceLogStore({
      maxBytesPerResource: 100,
      maxEntriesPerResource: 10,
      maxTotalBytes: 100,
      maxTotalEntries: 1,
    });
    const feed = store.createFeed();
    const other = store.createFeed();
    feed.write([{ observedAt: 1, stream: "stdout", text: "first" }]);
    other.write([{ observedAt: 2, stream: "stdout", text: "second" }]);
    const response = createResourceLogResponse({
      after: 0,
      onClose() {},
      projectId: "project-1",
      resourceName: "api",
      signal: new AbortController().signal,
      source: feed,
    });
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Expected a response body.");
    }

    expect(parseChunk(await reader.read())).toMatchObject({
      cursor: 1,
      droppedEntries: 1,
      entries: [],
      latestCursor: 1,
      retainedFrom: 2,
    });
    await reader.cancel();
  });

  test("serializes terminal failure diagnostics", async () => {
    const feed = new ResourceLogStore().createFeed();
    feed.complete(failure(createDiagnostic({ code: "SYD4999", message: "Capture failed." })));
    const response = createResourceLogResponse({
      after: 0,
      onClose() {},
      projectId: "project-1",
      resourceName: "api",
      signal: new AbortController().signal,
      source: feed,
    });

    expect((await readAllBatches(response))[0]).toMatchObject({
      failure: { diagnostics: [{ code: "SYD4999", message: "Capture failed." }] },
      status: "failed",
    });
  });
});

async function readAllBatches(response: Response): Promise<ResourceLogBatch[]> {
  const text = await response.text();
  return text
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => parseBatch(JSON.parse(line)));
}

function parseChunk(result: ByteStreamReadResult): ResourceLogBatch {
  if (result.done) {
    throw new Error("Expected another resource log batch.");
  }
  return parseBatch(JSON.parse(new TextDecoder().decode(result.value)));
}

type ByteStreamReadResult =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: undefined };

function parseBatch(input: unknown): ResourceLogBatch {
  const parsed = parseResourceLogBatch(input);
  if (!parsed.success) {
    throw new Error("Expected a valid resource log batch.");
  }
  return parsed.output;
}
