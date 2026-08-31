import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Dashboard root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Stackyard</h1>
    </main>
  </StrictMode>,
);
