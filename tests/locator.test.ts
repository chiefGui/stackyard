import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";

import { acquireDaemonLock, publishLocator } from "../apps/daemon/src/locator.ts";

/* oxlint-disable eslint/no-await-in-loop -- Stress iterations intentionally acquire and release one shared lock in sequence. */

test("concurrent daemon starts publish exactly one complete lock owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-lock-"));

  try {
    const results = await Promise.all([
      acquireLock(directory, "candidate-one"),
      acquireLock(directory, "candidate-two"),
    ]);

    const owners = results.filter((result) => result !== undefined);
    expect(owners).toHaveLength(1);
    if (owners[0]) {
      await Effect.runPromise(owners[0].release);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("concurrent daemon starts elect one owner while recovering a stale lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-lock-"));
  await mkdir(join(directory, "daemon.lock"));
  await writeFile(
    join(directory, "daemon.lock", "owner.json"),
    JSON.stringify({ instanceId: "stale", pid: 2_147_483_647 }),
  );

  try {
    const results = await Promise.all([
      acquireLock(directory, "candidate-one"),
      acquireLock(directory, "candidate-two"),
    ]);

    const owners = results.filter((result) => result !== undefined);
    expect(owners).toHaveLength(1);
    const owner = owners[0];
    if (!owner) {
      throw new Error("Expected one daemon lock owner.");
    }
    expect(["candidate-one", "candidate-two"]).toContain(owner.instanceId);
    await Effect.runPromise(owner.release);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("stale lock recovery treats disappearing publication as contention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-lock-"));

  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      await mkdir(join(directory, "daemon.lock"));
      await writeFile(
        join(directory, "daemon.lock", "owner.json"),
        JSON.stringify({ instanceId: "stale", pid: 2_147_483_647 }),
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, candidate) =>
          acquireLock(directory, `${iteration}-${candidate}`),
        ),
      );

      const owners = results.filter((result) => result !== undefined);
      expect(owners).toHaveLength(1);
      if (owners[0]) {
        await Effect.runPromise(owners[0].release);
      }
      expect(await readdir(directory)).toEqual([]);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("fails closed when a recovery owner died", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-lock-"));
  for (const name of ["daemon.lock", "daemon.lock.recovery"]) {
    await mkdir(join(directory, name));
    await writeFile(
      join(directory, name, "owner.json"),
      JSON.stringify({ instanceId: `stale-${name}`, pid: 2_147_483_647 }),
    );
  }

  try {
    const failed = await Effect.runPromise(
      acquireDaemonLock(directory, "replacement").pipe(
        Effect.flip,
        Effect.provide(BunServices.layer),
      ),
    );

    expect(failed.diagnostics[0].code).toBe("SYD3006");
    expect(failed.diagnostics[0].help).toContain("remove its lock directories");
    expect(failed.diagnostics[0].notes[0]).toContain("daemon.lock.recovery");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("failed locator publication removes its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stackyard-locator-"));
  await mkdir(join(directory, "daemon.json"));

  try {
    const published = await Effect.runPromiseExit(
      publishLocator(directory, {
        instanceId: "failed-publication",
        pid: process.pid,
        port: 3000,
        token: "test-token",
      }).pipe(Effect.provide(BunServices.layer)),
    );

    expect(Exit.isFailure(published)).toBeTrue();
    expect(await readdir(directory)).toEqual(["daemon.json"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function acquireLock(directory: string, instanceId: string) {
  return Effect.runPromise(
    acquireDaemonLock(directory, instanceId).pipe(Effect.provide(BunServices.layer)),
  );
}
