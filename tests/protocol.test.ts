import { describe, expect, test } from "bun:test";

import { formatDiagnostic, parseProjectSpec } from "../packages/protocol/src/index.ts";

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
    const result = parseProjectSpec({ ...validSpec, unexpected: true });

    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.diagnostics[0]?.code).toBe("SYD1000");
      expect(result.diagnostics[0]?.path).toEqual(["unexpected"]);
    }
  });

  test("rejects working directories outside the project root", () => {
    const result = parseProjectSpec({
      ...validSpec,
      resources: {
        api: { ...validSpec.resources.api, cwd: "../api" },
      },
    });

    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.diagnostics[0]?.path).toEqual(["resources", "api", "cwd"]);
    }
  });

  test("formats structural paths for people", () => {
    expect(
      formatDiagnostic({
        code: "SYD1000",
        message: "Invalid value.",
        path: ["resources", "api", "command", "args", 0],
      }),
    ).toBe("SYD1000 at resources.api.command.args[0]: Invalid value.");
  });
});
