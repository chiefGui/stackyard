import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Effect } from "effect";

export const normalizeProjectTarget = Effect.fn("normalizeProjectTarget")(function* (
  target: string,
  currentDirectory: string,
): Effect.fn.Return<string> {
  if (!isPathTarget(target)) {
    return target;
  }

  const absolute = resolve(currentDirectory, target);
  return yield* Effect.tryPromise({
    try: () => realpath(absolute),
    catch: () => absolute,
  }).pipe(Effect.catch((fallback) => Effect.succeed(fallback)));
});

function isPathTarget(target: string): boolean {
  return (
    isAbsolute(target) ||
    target === "." ||
    target === ".." ||
    target.startsWith(`.${sep}`) ||
    target.startsWith(`..${sep}`) ||
    target.includes("/") ||
    target.includes("\\")
  );
}
