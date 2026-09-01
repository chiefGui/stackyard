import { describe, expect, test } from "bun:test";
import { formatReleasePullRequestBody } from "../scripts/format-release-pr-body";

describe("release pull request body", () => {
  test("shows only the generated release details", () => {
    const generatedBody = `This PR was opened by Changesets.

# Releases
## stackyard@0.2.0

### Minor Changes

- Add project discovery. ([#42](https://github.com/chiefGui/stackyard/pull/42))`;

    expect(formatReleasePullRequestBody(generatedBody)).toBe(`## stackyard@0.2.0

### Minor Changes

- Add project discovery. ([#42](https://github.com/chiefGui/stackyard/pull/42))
`);
  });

  test("rejects an unexpected Changesets body", () => {
    expect(() => formatReleasePullRequestBody("No release details")).toThrow(
      'Changesets pull request body is missing "# Releases".',
    );
  });
});
