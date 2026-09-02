import { defineProject, endpoint, service } from "stackyard";

const development = service({
  command: ["bun", "dev"],
  endpoints: {
    api: endpoint.http({
      env: "STACKYARD_API_PORT",
      preferredPort: 3000,
    }),
    dashboard: endpoint.http({
      env: "STACKYARD_DASHBOARD_PORT",
      preferredPort: 5173,
    }),
  },
});

export default defineProject({
  name: "stackyard",
  resources: { development },
});
