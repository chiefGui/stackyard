import { defineProject, endpoint, service } from "stackyard";

const daemon = service({
  command: ["bun", "run", "dev"],
  cwd: "apps/daemon",
  endpoints: {
    control: endpoint.http({
      env: "PORT",
      preferredPort: 3000,
    }),
  },
});

const dashboardWeb = service({
  command: ["bun", "run", "dev"],
  cwd: "apps/dashboard-web",
  endpoints: {
    http: endpoint.http({
      env: "PORT",
      preferredPort: 5173,
    }),
  },
  env: {
    STACKYARD_CONTROL_URL: daemon.endpoints.control.url,
  },
});

export default defineProject({
  name: "stackyard",
  resources: { daemon, "dashboard-web": dashboardWeb },
});
