import { describe, expect, test } from "bun:test";

import { DiagnosticError } from "../packages/diagnostics/src/index.ts";
import {
  defineProject,
  endpoint,
  readProjectDefinition,
  service,
} from "../packages/sdk/src/index.ts";

describe("project definitions", () => {
  test("compiles services and symbolic endpoint values deterministically", () => {
    const api = service({
      command: ["bun", "api.ts"],
      endpoints: {
        http: endpoint.http({ env: "PORT", preferredPort: 3000 }),
      },
    });

    const definition = defineProject({
      name: "example",
      resources: {
        web: service({
          command: ["bun", "web.ts"],
          env: { API_URL: api.endpoints.http.url },
        }),
        api,
      },
    });

    const result = readProjectDefinition(definition);
    expect(result.success).toBeTrue();

    if (result.success) {
      expect(Object.keys(result.output.resources)).toEqual(["api", "web"]);
      expect(result.output.resources.web?.env.API_URL).toEqual({
        endpoint: "http",
        kind: "endpoint-url",
        resource: "api",
      });
      expect(Object.isFrozen(result.output)).toBeTrue();
    }
  });

  test("rejects references to services outside the project", () => {
    const api = service({
      command: ["bun", "api.ts"],
      endpoints: { http: endpoint.http({ env: "PORT" }) },
    });

    expectProjectError(
      () =>
        defineProject({
          name: "example",
          resources: {
            web: service({
              command: ["bun", "web.ts"],
              env: { API_URL: api.endpoints.http.url },
            }),
          },
        }),
      "SYD1107",
    );
  });

  test("rejects competing sources for endpoint environment variables", () => {
    expectProjectError(
      () =>
        defineProject({
          name: "example",
          resources: {
            api: service({
              command: ["bun", "api.ts"],
              endpoints: { http: endpoint.http({ env: "PORT" }) },
              env: { PORT: "3000" },
            }),
          },
        }),
      "SYD1105",
    );
  });

  test("rejects registering one descriptor under multiple names", () => {
    const api = service({ command: ["bun", "api.ts"] });

    expectProjectError(
      () => defineProject({ name: "example", resources: { api, duplicate: api } }),
      "SYD1101",
    );
  });

  test("explains accidental early string conversion", () => {
    const api = service({
      command: ["bun", "api.ts"],
      endpoints: { http: endpoint.http({ env: "PORT" }) },
    });

    expect(
      // This intentionally exercises the misuse that the runtime value rejects.
      // oxlint-disable-next-line typescript/no-base-to-string, typescript/restrict-template-expressions
      () => `${api.endpoints.http.url}`,
    ).toThrow("cannot be converted to strings");
  });
});

function expectProjectError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected the project definition to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(DiagnosticError);
    if (error instanceof DiagnosticError) {
      const diagnostic = error.diagnostics.find((candidate) => candidate.code === code);
      expect(diagnostic).toBeDefined();
      expect(typeof diagnostic?.help).toBe("string");
    }
  }
}
