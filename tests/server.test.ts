import { describe, expect, test } from "bun:test";

import { readPort, startServer, stopServer } from "../apps/server/src/server.ts";
import type { Diagnostic } from "../packages/diagnostics/src/index.ts";

describe("server configuration", () => {
  test("uses the default port when PORT is absent", () => {
    expect(readPort(undefined)).toEqual({ output: 3000, success: true });
  });

  test("accepts an explicit TCP port", () => {
    expect(readPort("4400")).toEqual({ output: 4400, success: true });
  });

  test.each(["", "0", "65536", "3e3", "3000.5", "port"])(
    "rejects invalid PORT value %p",
    (value) => {
      const result = readPort(value);

      expect(result.success).toBeFalse();
      if (!result.success) {
        expect(result.diagnostics[0].code).toBe("SYD3000");
        expect(result.diagnostics[0].help).toBe("Set PORT to a whole number from 1 to 65535.");
      }
    },
  );
});

describe("HTTP server", () => {
  test("reports an occupied port without throwing", async () => {
    const first = startServer({ diagnostics: { report() {} }, port: 0 });
    if (!first.success) {
      throw new Error("The test server could not start.");
    }

    try {
      const port = first.output.port;
      if (port === undefined) {
        throw new Error("The test server did not expose its assigned port.");
      }

      const second = startServer({
        diagnostics: { report() {} },
        port,
      });

      expect(second.success).toBeFalse();
      if (!second.success) {
        expect(second.diagnostics[0].code).toBe("SYD3001");
        expect(second.diagnostics[0].help).toContain("is available");
      }
    } finally {
      expect(await stopServer(first.output)).toEqual({ output: undefined, success: true });
    }
  });

  test("serves health and a diagnostic fallback over a real socket", async () => {
    const reported: Diagnostic[] = [];
    const result = startServer({
      diagnostics: {
        report(diagnostic) {
          reported.push(diagnostic);
        },
      },
      port: 0,
    });

    expect(result.success).toBeTrue();
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    try {
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);

      const health = await fetch(new URL("/health", server.url));
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(await health.json()).toEqual({ status: "ok" });

      const missing = await fetch(new URL("/missing", server.url));
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("no-store");
      expect(await missing.json()).toEqual({
        diagnostics: [
          {
            code: "SYD3002",
            help: "Check the request path and HTTP method, then retry.",
            message: "No Stackyard endpoint matches this request.",
            notes: ["Received GET /missing."],
            path: [],
            severity: "error",
          },
        ],
        schemaVersion: 1,
      });
      expect(reported).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });
});
