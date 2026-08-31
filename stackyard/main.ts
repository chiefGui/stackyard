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

const dashboard = service({
  command: ["bun", "run", "dev"],
  cwd: "apps/dashboard-web",
  endpoints: {
    http: endpoint.http({
      env: "PORT",
      preferredPort: 5173,
    }),
  },
});

export default defineProject({
  name: "stackyard",
  resources: { daemon, dashboard },
});
