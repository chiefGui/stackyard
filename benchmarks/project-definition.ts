import { bench, do_not_optimize, run } from "mitata";

import {
  parseProjectSpec,
  type ProcessResourceSpec,
  type ProjectSpec,
} from "../packages/protocol/src/index.ts";
import {
  defineProject,
  endpoint,
  service,
  type ResourceInputRecord,
} from "../packages/sdk/src/index.ts";

const resourceCounts = [1, 100, 1_000] as const;

for (const resourceCount of resourceCounts) {
  const spec = createProjectSpec(resourceCount);
  bench(`parse project spec (${resourceCount} resources)`, () => {
    do_not_optimize(parseProjectSpec(spec));
  });

  const resources = createResourceInputs(resourceCount);
  bench(`compile project definition (${resourceCount} resources)`, () => {
    do_not_optimize(defineProject({ name: "benchmark", resources }));
  });
}

await run({ throw: true });

function createProjectSpec(resourceCount: number): ProjectSpec {
  const resources: Record<string, ProcessResourceSpec> = {};

  for (let index = 0; index < resourceCount; index += 1) {
    resources[`service${index}`] = {
      command: { args: ["run", "start"], executable: "bun" },
      cwd: `apps/service${index}`,
      endpoints: {
        http: {
          kind: "http",
          port: { env: `PORT_${index}`, kind: "allocated", preferred: 3_000 + index },
        },
      },
      env: {
        LOG_LEVEL: "info",
        REGION: "local",
      },
      kind: "process",
    };
  }

  return { name: "benchmark", resources, schemaVersion: 1 };
}

function createResourceInputs(resourceCount: number): ResourceInputRecord {
  const resources: Record<string, ReturnType<typeof service>> = {};

  for (let index = 0; index < resourceCount; index += 1) {
    resources[`service${index}`] = service({
      command: ["bun", "run", "start"],
      cwd: `apps/service${index}`,
      endpoints: {
        http: endpoint.http({ env: `PORT_${index}`, preferredPort: 3_000 + index }),
      },
      env: {
        LOG_LEVEL: "info",
        REGION: "local",
      },
    });
  }

  return resources;
}
