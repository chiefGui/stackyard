import {
  createDiagnostic,
  describeError,
  failure,
  success,
  type Result,
} from "@stackyard/diagnostics";
import type { PortAllocator, PortLease } from "@stackyard/control-plane";

const host = "127.0.0.1";
const maximumEphemeralAttempts = 16;

/* oxlint-disable eslint/no-await-in-loop -- Rejected OS allocations must close before retrying. */

export class BunPortAllocator implements PortAllocator {
  readonly #claims = new Set<number>();
  #pending: Promise<void> = Promise.resolve();

  reserve(preferredPort: number | undefined): Promise<Result<PortLease>> {
    const reservation = this.#pending.then(() => this.#reserve(preferredPort));
    this.#pending = reservation.then(
      () => undefined,
      () => undefined,
    );
    return reservation;
  }

  async #reserve(preferredPort: number | undefined): Promise<Result<PortLease>> {
    let server: Bun.Server<undefined> | undefined;

    if (preferredPort !== undefined && !this.#claims.has(preferredPort)) {
      server = tryListen(preferredPort);
    }

    for (let attempt = 0; !server && attempt < maximumEphemeralAttempts; attempt += 1) {
      const candidate = tryListen(0);
      const candidatePort = candidate?.port;
      if (!candidate || candidatePort === undefined) {
        break;
      }
      if (!this.#claims.has(candidatePort)) {
        server = candidate;
        break;
      }
      const stopped = await stopServer(candidate, candidatePort);
      if (!stopped.success) {
        return stopped;
      }
    }

    const port = server?.port;
    if (!server || port === undefined) {
      if (server) {
        const stopped = await stopServer(server, server.port ?? 0);
        if (!stopped.success) {
          return stopped;
        }
      }
      return failure(
        createDiagnostic({
          code: "SYD4001",
          help: "Free a local TCP port or stop an existing Stackyard run, then retry.",
          message: "Stackyard could not allocate a service port.",
        }),
      );
    }

    this.#claims.add(port);
    let reservation: Bun.Server<undefined> | undefined = server;
    let disposed = false;

    return success(
      Object.freeze({
        host,
        port,
        dispose: async () => {
          if (disposed) {
            return success(undefined);
          }
          const released = await releaseReservation();
          if (!released.success) {
            return released;
          }
          disposed = true;
          this.#claims.delete(port);
          return success(undefined);
        },
        releaseReservation,
      }),
    );

    async function releaseReservation(): Promise<Result<void>> {
      if (!reservation) {
        return success(undefined);
      }
      try {
        await reservation.stop(true);
        reservation = undefined;
        return success(undefined);
      } catch (error) {
        return failure(
          createDiagnostic({
            code: "SYD4007",
            help: "Stop the Stackyard daemon before retrying the project.",
            message: `Port reservation ${port} could not be released.`,
            notes: [describeError(error)],
          }),
        );
      }
    }
  }
}

async function stopServer(server: Bun.Server<undefined>, port: number): Promise<Result<void>> {
  try {
    await server.stop(true);
    return success(undefined);
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD4007",
        help: "Stop the Stackyard daemon before retrying the project.",
        message: `Port reservation ${port} could not be released.`,
        notes: [describeError(error)],
      }),
    );
  }
}

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
