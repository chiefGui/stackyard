import { defineProject, endpoint, service } from "stackyard";

const daemon = service({
  command: ["bun", "run", "dev"],
  cwd: "apps/daemon",
  endpoints: {
    http: endpoint.http({
      env: "PORT",
      preferredPort: 3000,
    }),
  },
});

export default defineProject({
  name: "stackyard",
  resources: { daemon },
});
