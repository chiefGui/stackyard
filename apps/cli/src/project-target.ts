import { Effect, FileSystem, Path } from "effect";

export const normalizeProjectTarget = Effect.fn("normalizeProjectTarget")(function* (
  target: string,
  currentDirectory: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!isPathTarget(target, path)) {
    return target;
  }

  const absolute = path.resolve(currentDirectory, target);
  return yield* fileSystem.realPath(absolute).pipe(Effect.orElseSucceed(() => absolute));
});

function isPathTarget(target: string, path: Path.Path): boolean {
  return (
    path.isAbsolute(target) ||
    target === "." ||
    target === ".." ||
    target.startsWith(`.${path.sep}`) ||
    target.startsWith(`..${path.sep}`) ||
    target.includes("/") ||
    target.includes("\\")
  );
}
