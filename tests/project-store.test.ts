import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";

import {
  makeFileProjectDefinitionObserverLayer,
  makeFileProjectStoreLayer,
} from "../apps/daemon/src/projects.ts";
import { ProjectDefinitionObserver, ProjectStore } from "../packages/control-plane/src/index.ts";

test("the project store persists and replaces its complete snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-projects-"));
  const runtime = ManagedRuntime.make(
    makeFileProjectStoreLayer(directory).pipe(Layer.provide(BunServices.layer)),
  );
  const store = await runtime.runPromise(ProjectStore);
  try {
    expect(await Effect.runPromise(store.load)).toEqual([]);
    await Effect.runPromise(
      store.save([
        { id: "two", root: "/zeta" },
        { id: "one", root: "/alpha" },
      ]),
    );
    expect(await Effect.runPromise(store.load)).toEqual([
      { id: "one", root: "/alpha" },
      { id: "two", root: "/zeta" },
    ]);

    await Effect.runPromise(store.save([{ id: "two", root: "/zeta" }]));
    expect(await Effect.runPromise(store.load)).toEqual([{ id: "two", root: "/zeta" }]);
  } finally {
    await runtime.dispose();
    await rm(directory, { force: true, recursive: true });
  }
});

test("the project store refuses corrupt persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-projects-corrupt-"));
  try {
    await writeFile(join(directory, "projects.json"), "{", "utf8");

    const runtime = ManagedRuntime.make(
      makeFileProjectStoreLayer(directory).pipe(Layer.provide(BunServices.layer)),
    );
    const store = await runtime.runPromise(ProjectStore);
    const failed = await Effect.runPromise(store.load.pipe(Effect.flip));
    expect(failed.diagnostics[0].code).toBe("SYD3014");
    expect(failed.diagnostics[0].help).toContain("Removing it forgets every project");
    await runtime.dispose();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the project definition observer coalesces definition changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "stackyard-observer-"));
  const definitionDirectory = join(root, "stackyard");
  await mkdir(definitionDirectory);
  await writeFile(join(definitionDirectory, "main.ts"), "export {};\n", "utf8");
  let changes = 0;
  let changed!: () => void;
  const observedChange = new Promise<void>((resolveChange) => {
    changed = resolveChange;
  });
  const runtime = ManagedRuntime.make(makeFileProjectDefinitionObserverLayer({ report() {} }));
  const observer = await runtime.runPromise(ProjectDefinitionObserver);
  const observing = Effect.runPromise(
    Effect.gen(function* () {
      yield* observer.observe(root, () => {
        changes += 1;
        changed();
      });
      yield* Effect.promise(() => observedChange);
    }).pipe(Effect.scoped),
  );

  try {
    await writeFile(join(definitionDirectory, "main.ts"), "export const changed = true;\n", "utf8");
    await Promise.race([
      observing,
      Bun.sleep(2_000).then(() => {
        throw new Error("Timed out waiting for a definition change.");
      }),
    ]);
    await Bun.sleep(150);
    expect(changes).toBe(1);
  } finally {
    await runtime.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
