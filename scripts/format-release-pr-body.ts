const releasesHeading = "# Releases";

export function formatReleasePullRequestBody(generatedBody: string): string {
  const headingIndex = generatedBody.indexOf(releasesHeading);

  if (headingIndex === -1) {
    throw new Error('Changesets pull request body is missing "# Releases".');
  }

  const releaseDetails = generatedBody.slice(headingIndex + releasesHeading.length).trim();

  if (releaseDetails.length === 0) {
    throw new Error("Changesets pull request body has no release details.");
  }

  return `${releaseDetails}\n`;
}

if (import.meta.main) {
  const generatedBody = await Bun.stdin.text();
  process.stdout.write(formatReleasePullRequestBody(generatedBody));
}
