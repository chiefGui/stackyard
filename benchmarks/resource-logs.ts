import { bench, do_not_optimize, run } from "mitata";

import { ResourceLogStore } from "../packages/control-plane/src/index.ts";
import { createResourceLogBatch } from "../packages/protocol/src/index.ts";

const store = new ResourceLogStore();
const feed = store.createFeed();
const batch = Object.freeze(
  Array.from({ length: 64 }, (_, index) =>
    Object.freeze({
      observedAt: index,
      stream: "stdout" as const,
      text: `request=${index.toString().padStart(2, "0")} status=200 duration=12ms path=/api/widgets`,
    }),
  ),
);

bench("append 64 resource log lines at steady state", () => {
  feed.write(batch);
});

const snapshotFeed = new ResourceLogStore().createFeed();
for (let offset = 0; offset < 10_000; offset += batch.length) {
  snapshotFeed.write(batch);
}

bench("read 256 lines from a full resource log feed", () => {
  do_not_optimize(snapshotFeed.snapshot({ after: 9_744, limit: 256 }));
});

const snapshot = snapshotFeed.snapshot({ after: 9_744, limit: 256 });
if (snapshot.status !== "live") {
  throw new Error("Benchmark resource log feed completed unexpectedly.");
}
const protocolBatch = createResourceLogBatch({
  cursor: snapshot.nextCursor,
  droppedEntries: snapshot.droppedEntries,
  entries: snapshot.entries,
  latestCursor: snapshot.latestCursor,
  projectId: "benchmark-project",
  resourceName: "api",
  retainedFrom: snapshot.retainedFrom,
  status: snapshot.status,
});
const encoder = new TextEncoder();

bench("encode a 256-line resource log transport batch", () => {
  do_not_optimize(encoder.encode(`${JSON.stringify(protocolBatch)}\n`));
});

await run({ throw: true });
