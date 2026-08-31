import {
  createDiagnostic,
  createDiagnosticReport,
  failure,
  success,
  type Diagnostic,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";

const defaultPort = 3000;
const hostname = "127.0.0.1";
const portPattern = /^\d+$/;

export interface ServerOptions {
  readonly diagnostics: DiagnosticSink;
  readonly port: number;
}

export function readPort(value: string | undefined): Result<number> {
  if (value === undefined) {
    return success(defaultPort);
  }

  const port = portPattern.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return failure(
      createDiagnostic({
        code: "SYD3000",
        help: "Set PORT to a whole number from 1 to 65535.",
        message: "PORT is not a valid TCP port.",
        notes: [`Received ${JSON.stringify(value)}.`],
        path: ["PORT"],
      }),
    );
  }

  return success(port);
}

export function startServer(options: ServerOptions): Result<Bun.Server<undefined>> {
  try {
    return success(
      Bun.serve({
        hostname,
        port: options.port,
        routes: {
          "/health": {
            GET: () =>
              Response.json(
                { status: "ok" },
                {
                  headers: { "cache-control": "no-store" },
                },
              ),
          },
        },
        fetch(request) {
          const url = new URL(request.url);
          return diagnosticResponse(
            createDiagnostic({
              code: "SYD3002",
              help: "Check the request path and HTTP method, then retry.",
              message: "No Stackyard endpoint matches this request.",
              notes: [`Received ${request.method} ${url.pathname}.`],
            }),
            404,
          );
        },
        error(error) {
          const diagnostic = createDiagnostic({
            code: "SYD3003",
            help: "Check the Stackyard server output for the underlying error, then retry.",
            message: "The Stackyard server could not complete the request.",
            notes: [describeError(error)],
          });
          options.diagnostics.report(diagnostic);
          return diagnosticResponse(createDiagnostic({ ...diagnostic, notes: [] }), 500);
        },
      }),
    );
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD3001",
        help: `Confirm that http://${hostname}:${options.port} is available, then retry.`,
        message: "The Stackyard server could not start.",
        notes: [describeError(error)],
      }),
    );
  }
}

export async function stopServer(server: Bun.Server<undefined>): Promise<Result<void>> {
  try {
    await server.stop();
    return success(undefined);
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD3004",
        help: "Stop any remaining Stackyard processes before starting the server again.",
        message: "The Stackyard server did not shut down cleanly.",
        notes: [describeError(error)],
      }),
    );
  }
}

function diagnosticResponse(diagnostic: Diagnostic, status: number): Response {
  return Response.json(createDiagnosticReport([diagnostic]), {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function describeError(error: unknown): string {
  const message =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
  if (typeof message === "string" && message.trim()) {
    return message;
  }

  return "The runtime did not provide additional error details.";
}
