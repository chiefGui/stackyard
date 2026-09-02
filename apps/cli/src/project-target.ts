import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export async function normalizeProjectTarget(
  target: string,
  currentDirectory: string,
): Promise<string> {
  if (!isPathTarget(target)) {
    return target;
  }

  const absolute = resolve(currentDirectory, target);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function isPathTarget(target: string): boolean {
  return (
    isAbsolute(target) ||
    target === "." ||
    target === ".." ||
    target.startsWith(`.${sep}`) ||
    target.startsWith(`..${sep}`) ||
    target.includes("/") ||
    target.includes("\\")
  );
}
