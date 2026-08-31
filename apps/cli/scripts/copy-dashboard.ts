import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const target = resolve(packageRoot, "dist/dashboard");

await rm(target, { force: true, recursive: true });
await cp(resolve(packageRoot, "../dashboard-web/dist"), target, { recursive: true });
