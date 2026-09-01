import { createDiagnostic, failure, success, type Result } from "@stackyard/diagnostics";

const defaultPort = 3000;
const portPattern = /^\d+$/;

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
