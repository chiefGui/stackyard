import { PortAllocator, type PortLease } from "@stackyard/control-plane";
import { createDiagnostic, describeError, failure, type Failure } from "@stackyard/diagnostics";
import { Effect, Layer, Semaphore } from "effect";

const host = "127.0.0.1";
const maximumEphemeralAttempts = 16;

export const BunPortAllocatorLayer: Layer.Layer<PortAllocator> = Layer.effect(
  PortAllocator,
  Effect.gen(function* () {
    const claims = new Set<number>();
    const mutation = yield* Semaphore.make(1);

    const reserve = Effect.fn("BunPortAllocator.reserve")((preferredPort: number | undefined) =>
      mutation.withPermits(1)(reservePort(claims, mutation, preferredPort)),
    );

    return PortAllocator.of({ reserve });
  }),
);

const reservePort = Effect.fn("BunPortAllocator.reservePort")(function* (
  claims: Set<number>,
  mutation: Semaphore.Semaphore,
  preferredPort: number | undefined,
): Effect.fn.Return<PortLease, Failure> {
  let server: Bun.Server<undefined> | undefined;

  if (preferredPort !== undefined && !claims.has(preferredPort)) {
    server = tryListen(preferredPort);
  }

  for (let attempt = 0; !server && attempt < maximumEphemeralAttempts; attempt += 1) {
    const candidate = tryListen(0);
    const candidatePort = candidate?.port;
    if (!candidate || candidatePort === undefined) {
      break;
    }
    if (!claims.has(candidatePort)) {
      server = candidate;
      break;
    }
    yield* stopServer(candidate, candidatePort);
  }

  const port = server?.port;
  if (!server || port === undefined) {
    if (server) {
      yield* stopServer(server, server.port ?? 0);
    }
    return yield* Effect.fail(
      failure(
        createDiagnostic({
          code: "SYD4001",
          help: "Free the local TCP port or stop the Stackyard project using it, then retry.",
          message: "Stackyard could not allocate a service port.",
        }),
      ),
    );
  }

  claims.add(port);
  let reservation: Bun.Server<undefined> | undefined = server;
  let disposed = false;

  const release = Effect.fn("BunPortAllocator.releaseReservation")(function* () {
    if (!reservation) {
      return;
    }
    yield* stopServer(reservation, port);
    reservation = undefined;
  });

  const releaseReservation = mutation.withPermits(1)(Effect.suspend(release));
  const dispose = mutation.withPermits(1)(
    Effect.suspend(() => {
      if (disposed) {
        return Effect.void;
      }
      return release().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            disposed = true;
            claims.delete(port);
          }),
        ),
      );
    }),
  );

  return Object.freeze({ dispose, host, port, releaseReservation });
});

const stopServer = Effect.fn("BunPortAllocator.stopServer")(
  (server: Bun.Server<undefined>, port: number): Effect.Effect<void, Failure> =>
    Effect.tryPromise({
      try: () => server.stop(true),
      catch: (error) =>
        failure(
          createDiagnostic({
            code: "SYD4007",
            help: "Stop the Stackyard daemon before retrying the project.",
            message: `Port reservation ${port} could not be released.`,
            notes: [describeError(error)],
          }),
        ),
    }),
);

function tryListen(port: number): Bun.Server<undefined> | undefined {
  try {
    return Bun.serve({
      fetch: () => new Response(null, { status: 503 }),
      hostname: host,
      port,
    });
  } catch {
    return undefined;
  }
}
