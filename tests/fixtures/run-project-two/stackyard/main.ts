import { defineProject, endpoint, service } from "stackyard";

export default defineProject({
  name: "run-fixture-two",
  resources: {
    worker: service({
      command: ["bun", "service.ts"],
      cwd: ".",
      endpoints: {
        http: endpoint.http({ env: "PORT", preferredPort: 43_210 }),
      },
    }),
  },
});
