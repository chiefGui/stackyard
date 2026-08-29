import { describe, expect, test } from "bun:test";

import type { NonEmptyDiagnostics } from "../packages/diagnostics/src/index.ts";
import { parseProjectSpec } from "../packages/protocol/src/index.ts";

const validSpec = {
  name: "example",
  resources: {
    api: {
      command: { args: ["run", "dev"], executable: "bun" },
      cwd: "apps/api",
      endpoints: {
        http: {
          kind: "http",
          port: { env: "PORT", kind: "allocated", preferred: 3000 },
        },
      },
      env: {},
      kind: "process",
    },
  },
  schemaVersion: 1,
} as const;

describe("ProjectSpec", () => {
  test("parses the canonical project model", () => {
    expect(parseProjectSpec(validSpec)).toEqual({ output: validSpec, success: true });
  });

  test("rejects unknown properties", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      anotherUnexpected: true,
      unexpected: true,
    });

    expect(diagnostics[0]).toEqual({
      code: "SYD1000",
      message: "Property is not recognized.",
      path: ["anotherUnexpected"],
      severity: "error",
    });
    expect(diagnostics[1]?.path).toEqual(["unexpected"]);
  });

  test("rejects unknown properties at their exact nested path", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: {
          ...validSpec.resources.api,
          command: { ...validSpec.resources.api.command, unexpected: true },
        },
      },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "api", "command", "unexpected"]);
  });

  test("rejects working directories outside the project root", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: { ...validSpec.resources.api, cwd: "../api" },
      },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "api", "cwd"]);
    expect(diagnostics[0]?.message).toBe("Must be a portable path inside the project root.");
  });

  test("preserves resource key validation details", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: { "Bad key": validSpec.resources.api },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "Bad key"]);
    expect(diagnostics[0]?.message).toBe(
      "Must start with a lowercase letter and contain only letters, numbers, and hyphens.",
    );
  });

  test("preserves environment key validation details", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: { ...validSpec.resources.api, env: { "bad-key": "value" } },
      },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "api", "env", "bad-key"]);
    expect(diagnostics[0]?.message).toBe("Must be a valid environment variable name.");
  });

  test("reports invalid endpoint references at the environment value", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: {
          ...validSpec.resources.api,
          env: {
            API_URL: { endpoint: "http", kind: "invalid", resource: "api" },
          },
        },
      },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "api", "env", "API_URL"]);
    expect(diagnostics[0]?.message).toBe("Must be a string or endpoint reference.");
  });

  test("collects independent validation failures", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      name: "Invalid",
      resources: {
        api: {
          ...validSpec.resources.api,
          cwd: "../api",
          endpoints: {
            http: {
              ...validSpec.resources.api.endpoints.http,
              port: {
                ...validSpec.resources.api.endpoints.http.port,
                preferred: 70_000,
              },
            },
          },
        },
      },
    });

    expect(diagnostics.map(({ path }) => path)).toEqual([
      ["name"],
      ["resources", "api", "cwd"],
      ["resources", "api", "endpoints", "http", "port", "preferred"],
    ]);
  });
});

function parseDiagnostics(input: unknown): NonEmptyDiagnostics {
  const result = parseProjectSpec(input);

  if (result.success) {
    throw new Error("Expected project parsing to fail.");
  }

  return result.diagnostics;
}
