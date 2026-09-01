import { createFileRoute } from "@tanstack/react-router";

import { ProjectsPage } from "../feature/projects/projects-page.tsx";

export const Route = createFileRoute("/")({ component: ProjectsPage });
