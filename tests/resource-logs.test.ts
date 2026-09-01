import { describe, expect, test } from "bun:test";

import { ResourceLogStore } from "../packages/control-plane/src/index.ts";
import { success } from "../packages/diagnostics/src/index.ts";

describe("resource log store", () => {
  test("assigns stable cursors and returns bounded snapshots", async () => {
    const feed = new ResourceLogStore().createFeed();
    const changed = feed.waitForChange(0);

    feed.write([
      { observedAt: 10, stream: "stdout", text: "ready" },
      { observedAt: 11, stream: "stderr", text: "" },
    ]);
    await changed;

    expect(feed.snapshot()).toMatchObject({
      droppedEntries: 0,
      entries: [
        { observedAt: 10, sequence: 1, stream: "stdout", text: "ready" },
        { observedAt: 11, sequence: 2, stream: "stderr", text: "" },
      ],
      hasMore: false,
      nextCursor: 2,
      retainedFrom: 1,
      revision: 1,
      status: "live",
    });
    expect(feed.snapshot({ after: 1, limit: 1 })).toMatchObject({
      entries: [{ sequence: 2 }],
      hasMore: false,
      nextCursor: 2,
    });
    expect(Object.isFrozen(feed.snapshot().entries)).toBeTrue();
  });

  test("makes per-resource eviction and UTF-8 truncation explicit", () => {
    const store = new ResourceLogStore({
      maxBytesPerResource: 6,
      maxEntriesPerResource: 3,
    });
    const feed = store.createFeed();
    feed.write([
      { observedAt: 1, stream: "stdout", text: "aa" },
      { observedAt: 2, stream: "stdout", text: "bb" },
      { observedAt: 3, stream: "stdout", text: "cc" },
      { observedAt: 4, stream: "stdout", text: "dd" },
    ]);

    expect(feed.snapshot()).toMatchObject({
      droppedEntries: 1,
      entries: [
        { sequence: 2, text: "bb" },
        { sequence: 3, text: "cc" },
        { sequence: 4, text: "dd" },
      ],
      retainedFrom: 2,
    });

    const unicode = store.createFeed();
    unicode.write([{ observedAt: 5, stream: "stderr", text: "éééé" }]);
    expect(unicode.snapshot().entries).toEqual([
      { observedAt: 5, sequence: 1, stream: "stderr", text: "ééé", truncatedBytes: 2 },
    ]);
  });

  test("evicts the globally oldest entries across resources", () => {
    const store = new ResourceLogStore({
      maxBytesPerResource: 100,
      maxEntriesPerResource: 10,
      maxTotalBytes: 100,
      maxTotalEntries: 3,
    });
    const first = store.createFeed();
    const second = store.createFeed();
    first.write([{ observedAt: 1, stream: "stdout", text: "first-1" }]);
    second.write([{ observedAt: 2, stream: "stdout", text: "second-1" }]);
    first.write([{ observedAt: 3, stream: "stdout", text: "first-2" }]);
    second.write([{ observedAt: 4, stream: "stdout", text: "second-2" }]);

    expect(first.snapshot()).toMatchObject({
      droppedEntries: 1,
      entries: [{ sequence: 2, text: "first-2" }],
      revision: 3,
    });
    expect(second.snapshot().entries.map(({ text }) => text)).toEqual(["second-1", "second-2"]);
  });

  test("keeps global accounting bounded through sustained local eviction", () => {
    const store = new ResourceLogStore({
      maxBytesPerResource: 100,
      maxEntriesPerResource: 3,
      maxTotalBytes: 100,
      maxTotalEntries: 3,
    });
    const feed = store.createFeed();
    for (let index = 1; index <= 100; index += 1) {
      feed.write([{ observedAt: index, stream: "stdout", text: String(index) }]);
    }

    expect(feed.snapshot()).toMatchObject({
      droppedEntries: 97,
      entries: [{ sequence: 98 }, { sequence: 99 }, { sequence: 100 }],
      retainedFrom: 98,
    });
  });

  test("wakes readers for terminal state without allocating an event queue", async () => {
    const feed = new ResourceLogStore().createFeed();
    const initial = feed.snapshot();
    const changed = feed.waitForChange(initial.revision);

    feed.complete(success(undefined));
    await changed;

    expect(feed.snapshot()).toMatchObject({
      completion: { output: undefined, success: true },
      revision: initial.revision + 1,
      status: "complete",
    });
    await feed.waitForChange(initial.revision);
    expect(() => feed.write([{ observedAt: 1, stream: "stdout", text: "late" }])).toThrow();
  });

  test("supports cancellation and observable removal", async () => {
    const feed = new ResourceLogStore().createFeed();
    const cancellation = new AbortController();
    const waiting = feed.waitForChange(feed.snapshot().revision, cancellation.signal);
    cancellation.abort();
    expect(waiting).rejects.toMatchObject({ name: "AbortError" });

    const removed = feed.waitForChange(feed.snapshot().revision);
    feed.remove();
    await removed;
    expect(feed.snapshot()).toMatchObject({ entries: [], status: "removed" });
  });
});
