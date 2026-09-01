import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");

await copyFile(resolve(repositoryRoot, "LICENSE"), resolve(packageRoot, "LICENSE"));
