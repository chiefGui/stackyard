import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { router } from "./app/router.tsx";

// oxlint-disable-next-line import/no-unassigned-import -- Fontsource registers the local font face.
import "@fontsource-variable/inter/wght.css";
// oxlint-disable-next-line import/no-unassigned-import -- Vite injects stylesheet imports.
import "./styling/app.css";

const queryClient = new QueryClient();

const root = document.getElementById("root");
if (!root) {
  throw new Error("Dashboard root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
