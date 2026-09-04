import { createDiagnostic, describeError, failure, type Failure } from "@stackyard/diagnostics";
import { Effect, FileSystem, Path, Predicate, type PlatformError } from "effect";

export interface ProjectLocation {
  readonly entrypoint: string;
  readonly root: string;
}

export const discoverProject = Effect.fn("discoverProject")(function* (
  input: string | undefined,
  currentDirectory: string,
): Effect.fn.Return<ProjectLocation, Failure, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  return yield* input
    ? discoverExplicitProject(path.resolve(currentDirectory, input))
    : discoverFromAncestors(path.resolve(currentDirectory));
});

const discoverFromAncestors = Effect.fn("discoverFromAncestors")(function* (
  startingDirectory: string,
) {
  const path = yield* Path.Path;
  let directory = startingDirectory;
  while (true) {
    const location = yield* locationFromDirectory(directory);
    if (location) {
      return location;
    }
    const parent = path.dirname(directory);
    if (parent === directory || directory === path.parse(directory).root) {
      return yield* Effect.fail(notFound(startingDirectory));
    }
    directory = parent;
  }
});

const discoverExplicitProject = Effect.fn("discoverExplicitProject")(function* (path: string) {
  const paths = yield* Path.Path;
  const pathStat = yield* statIfExists(path);
  if (pathStat?.type === "File") {
    return { entrypoint: path, root: paths.dirname(paths.dirname(path)) };
  }
  if (pathStat?.type === "Directory") {
    const location = yield* locationFromDirectory(path);
    if (location) {
      return location;
    }
  }
  return yield* Effect.fail(notFound(path));
});

const locationFromDirectory = Effect.fn("locationFromDirectory")(function* (root: string) {
  const path = yield* Path.Path;
  const entrypoint = path.join(root, "stackyard", "main.ts");
  const entrypointStat = yield* statIfExists(entrypoint);
  return entrypointStat?.type === "File" ? { entrypoint, root } : undefined;
});

const statIfExists = Effect.fn("statIfExists")(
  (path: string): Effect.Effect<FileSystem.File.Info | undefined, Failure, FileSystem.FileSystem> =>
    FileSystem.FileSystem.use((fileSystem) => fileSystem.stat(path)).pipe(
      Effect.catch((error) =>
        isMissing(error)
          ? Effect.succeed(undefined)
          : Effect.fail(
              failure(
                createDiagnostic({
                  code: "SYD2006",
                  help: "Verify that the project path exists and is readable, then retry.",
                  message: "Project discovery failed.",
                  notes: [describeError(error)],
                }),
              ),
            ),
      ),
    ),
);

function isMissing(error: PlatformError.PlatformError): boolean {
  return Predicate.isTagged(error.reason, "NotFound");
}

function notFound(path: string): Failure {
  return failure(
    createDiagnostic({
      code: "SYD2000",
      help: "Create stackyard/main.ts or pass the path to an existing Stackyard project.",
      message: `No stackyard/main.ts was found from '${path}'.`,
    }),
  );
}
