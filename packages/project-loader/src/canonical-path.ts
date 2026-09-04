import { realpath } from "node:fs/promises";

import { Context, Effect, Layer, Schema } from "effect";

export class CanonicalPathError extends Schema.TaggedError<CanonicalPathError>()(
  "CanonicalPathError",
  {
    cause: Schema.Defect(),
    path: Schema.String,
  },
) {}

export class CanonicalPath extends Context.Service<
  CanonicalPath,
  {
    readonly resolve: (path: string) => Effect.Effect<string, CanonicalPathError>;
  }
>()("stackyard/project-loader/CanonicalPath") {}

export const NodeCanonicalPathLayer: Layer.Layer<CanonicalPath> = Layer.succeed(
  CanonicalPath,
  CanonicalPath.of({
    resolve: Effect.fn("CanonicalPath.resolve")((path: string) =>
      Effect.tryPromise({
        try: () => realpath(path),
        catch: (cause) => new CanonicalPathError({ cause, path }),
      }),
    ),
  }),
);
