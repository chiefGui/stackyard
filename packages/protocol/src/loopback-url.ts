export function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/[^\s]*)?$/.exec(value);
  if (!match) {
    return false;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}
