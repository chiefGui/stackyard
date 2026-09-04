import { resolve } from "node:path";

import { BunRuntime } from "@effect/platform-bun";
import { ProcessHost } from "../../packages/control-plane/src/index.ts";
import { Effect } from "effect";

import { makeBunProcessHostLayer } from "../../apps/daemon/src/processes.ts";

BunRuntime.runMain(
  Effect.gen(function* () {
    const processes = yield* ProcessHost;
    const started = yield* processes.start({
      args: [resolve(import.meta.dir, "process-tree.ts")],
      env: { ...stringEnvironment(process.env) },
      executable: process.execPath,
      logs: { write() {} },
      projectRoot: resolve(import.meta.dir, "../.."),
      workingDirectory: ".",
    });
    process.stdout.write(`${started.pid}\n`);
    return yield* Effect.never;
  }).pipe(Effect.provide(makeBunProcessHostLayer({ report() {} }))),
);

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
