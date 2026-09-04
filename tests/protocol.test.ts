import { describe, expect, test } from "bun:test";

import type { NonEmptyDiagnostics } from "../packages/diagnostics/src/index.ts";
import { createProjectSpec, parseProjectSpec } from "../packages/protocol/src/index.ts";

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
      startWithProject: true,
    },
  },
  schemaVersion: 1,
} as const;

describe("ProjectSpec", () => {
  test("owns the schema version when creating the canonical model", () => {
    const result = createProjectSpec({
      name: validSpec.name,
      resources: validSpec.resources,
    });

    expect(result).toEqual({ output: validSpec, success: true });
    if (result.success) {
      expect(result.output.schemaVersion).toBe(1);
      expect(Object.isFrozen(result.output)).toBeTrue();
      expect(Object.isFrozen(result.output.resources)).toBeTrue();
      expect(Object.isFrozen(result.output.resources.api?.command.args)).toBeTrue();
    }
  });

  test("parses the canonical project model", () => {
    const result = parseProjectSpec(validSpec);

    expect(result).toEqual({ output: validSpec, success: true });
    if (result.success) {
      expect(Object.isFrozen(result.output)).toBeTrue();
    }
  });

  test("reports missing, invalid, and unsupported schema versions explicitly", () => {
    const missing = parseDiagnostics({
      name: validSpec.name,
      resources: validSpec.resources,
    });
    expect(missing[0]).toMatchObject({
      code: "SYD1008",
      message: "Project specification schema version is missing.",
      path: ["schemaVersion"],
    });
    expect(missing[0]?.help).toContain("Regenerate");

    const invalid = parseDiagnostics({ ...validSpec, schemaVersion: "1" });
    expect(invalid[0]).toMatchObject({
      code: "SYD1008",
      message: "Project specification schema version must be a positive integer.",
      path: ["schemaVersion"],
    });
    expect(invalid[0]?.help).toContain("Regenerate");

    const unsupported = parseDiagnostics({ ...validSpec, schemaVersion: 2 });
    expect(unsupported[0]).toMatchObject({
      code: "SYD1008",
      message: "Project specification schema version 2 is not supported.",
      notes: ["Supported schema version: 1."],
      path: ["schemaVersion"],
    });
    expect(unsupported[0]?.help).toContain("Update Stackyard");
  });

  test("rejects unknown properties", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      anotherUnexpected: true,
      unexpected: true,
    });

    expect(diagnostics[0]).toEqual({
      code: "SYD1001",
      help: "Remove the property or replace it with a supported property.",
      message: "Property is not recognized.",
      notes: [],
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
    expect(diagnostics[0]?.code).toBe("SYD1005");
    expect(diagnostics[0]?.message).toBe(
      "Working directory is not a portable project-relative path.",
    );
    expect(diagnostics[0]?.help).toContain("apps/api");
  });

  test("rejects invalid project-start behavior", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: { ...validSpec.resources.api, startWithProject: "sometimes" },
      },
    });

    expect(diagnostics).toMatchObject([
      {
        code: "SYD1013",
        message: "Service property 'startWithProject' must be true or false.",
        path: ["resources", "api", "startWithProject"],
      },
    ]);
  });

  test("rejects project-start services that depend on opted-out services", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: { ...validSpec.resources.api, startWithProject: false },
        web: {
          command: { args: [], executable: "bun" },
          cwd: "apps/web",
          endpoints: {},
          env: {
            API_URL: { endpoint: "http", kind: "endpoint-url", resource: "api" },
          },
          kind: "process",
          startWithProject: true,
        },
      },
    });

    expect(diagnostics).toMatchObject([
      {
        code: "SYD1014",
        message:
          "Service 'web' starts with the project but depends on service 'api', which does not.",
        path: ["resources", "web", "env", "API_URL"],
      },
    ]);
  });

  test("preserves resource key validation details", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: { "Bad key": validSpec.resources.api },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "Bad key"]);
    expect(diagnostics[0]?.code).toBe("SYD1003");
    expect(diagnostics[0]?.message).toBe("Identifier contains unsupported characters.");
    expect(diagnostics[0]?.help).toContain("starting with a lowercase letter");
  });

  test("preserves environment key validation details", () => {
    const diagnostics = parseDiagnostics({
      ...validSpec,
      resources: {
        api: { ...validSpec.resources.api, env: { "bad-key": "value" } },
      },
    });

    expect(diagnostics[0]?.path).toEqual(["resources", "api", "env", "bad-key"]);
    expect(diagnostics[0]?.code).toBe("SYD1004");
    expect(diagnostics[0]?.message).toBe("Environment variable name is invalid.");
    expect(diagnostics[0]?.help).toContain("underscores");
  });

  test("classifies invalid environment values by their structural location", () => {
    const invalidValues: readonly unknown[] = [
      42,
      { endpoint: "http", kind: "invalid", resource: "api" },
    ];

    for (const invalidValue of invalidValues) {
      const diagnostics = parseDiagnostics({
        ...validSpec,
        resources: {
          api: {
            ...validSpec.resources.api,
            env: { API_URL: invalidValue },
          },
        },
      });

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.path).toEqual(["resources", "api", "env", "API_URL"]);
      expect(diagnostics[0]?.code).toBe("SYD1007");
      expect(diagnostics[0]?.message).toBe(
        "Environment value must be a string or endpoint reference.",
      );
      expect(diagnostics[0]?.help).toContain(".url");
    }
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
    expect(diagnostics.map(({ code }) => code)).toEqual(["SYD1002", "SYD1005", "SYD1006"]);
  });

  test("rejects projects without resources", () => {
    const diagnostics = parseDiagnostics({ ...validSpec, resources: {} });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("SYD1009");
    expect(diagnostics[0]?.path).toEqual(["resources"]);
    expect(diagnostics[0]?.help).toBe("Add at least one service to the project resources.");
  });

  test("rejects non-portable endpoint environment ownership", () => {
    const input = {
      ...validSpec,
      resources: {
        api: {
          ...validSpec.resources.api,
          endpoints: {
            ...validSpec.resources.api.endpoints,
            management: {
              kind: "http",
              port: { env: "port", kind: "allocated" },
            },
          },
          env: { FOO: "one", Port: "3000", foo: "two" },
        },
      },
    };

    const result = parseProjectSpec(input);

    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.diagnostics.map(({ code }) => code)).toEqual(["SYD1010", "SYD1011", "SYD1012"]);
      const [endpointDiagnostic, portDiagnostic, environmentDiagnostic] = result.diagnostics;
      if (!portDiagnostic || !environmentDiagnostic) {
        throw new Error("Expected three environment collision diagnostics.");
      }
      expect(endpointDiagnostic.path).toEqual([
        "resources",
        "api",
        "endpoints",
        "management",
        "port",
        "env",
      ]);
      expect(portDiagnostic.path).toEqual(["resources", "api", "env", "Port"]);
      expect(environmentDiagnostic.path).toEqual(["resources", "api", "env", "foo"]);
    }
  });
});

function parseDiagnostics(input: unknown): NonEmptyDiagnostics {
  const result = parseProjectSpec(input);

  if (result.success) {
    throw new Error("Expected project parsing to fail.");
  }

  return result.diagnostics;
}
