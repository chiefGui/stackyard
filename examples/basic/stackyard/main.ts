import { defineProject, endpoint, service } from "stackyard";

export default defineProject({
  name: "basic",
  resources: {
    web: service({
      command: ["bun", "service.ts"],
      endpoints: {
        http: endpoint.http({ env: "PORT" }),
      },
    }),
  },
});
