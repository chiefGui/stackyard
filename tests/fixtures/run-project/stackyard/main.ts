import { defineProject, endpoint, service } from "stackyard";

export default defineProject({
  name: "run-fixture",
  resources: {
    api: service({
      command: ["bun", "service.ts"],
      cwd: ".",
      endpoints: {
        http: endpoint.http({ env: "PORT", preferredPort: 43_210 }),
      },
    }),
    worker: service({
      command: ["bun", "worker.ts"],
      cwd: ".",
      startup: "manual",
    }),
  },
});
