import { defineProject, endpoint, service } from "stackyard";

export default defineProject({
  name: "packed-run",
  resources: {
    api: service({
      command: ["bun", "service.js"],
      cwd: ".",
      endpoints: {
        http: endpoint.http({ env: "PORT" }),
      },
    }),
  },
});
