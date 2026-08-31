import { defineProject, endpoint, service } from "stackyard";

const server = service({
  command: ["bun", "run", "dev"],
  cwd: "apps/server",
  endpoints: {
    http: endpoint.http({
      env: "PORT",
      preferredPort: 3000,
    }),
  },
});

export default defineProject({
  name: "stackyard",
  resources: { server },
});
