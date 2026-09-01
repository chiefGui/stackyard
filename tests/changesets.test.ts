import { describe, expect, test } from "bun:test";
import {
  expectedReleaseType,
  getConventionalSummary,
  parseChangeset,
  validateChangeset,
} from "../scripts/validate-changesets";

describe("Changeset validation", () => {
  test("parses metadata and a conventional summary", () => {
    const changeset = parseChangeset(`---
"stackyard": minor
---

pr: #11
refactor!: establish the dashboard foundation
`);

    expect(changeset).toEqual({
      releases: [{ name: "stackyard", type: "minor" }],
      summary: "pr: #11\nrefactor!: establish the dashboard foundation",
    });
    expect(getConventionalSummary(changeset.summary)).toEqual({
      breaking: true,
      line: "refactor!: establish the dashboard foundation",
      type: "refactor",
    });
  });

  test("accepts empty Changesets", () => {
    expect(() => validateChangeset("internal.md", "---\n---\n", new Map())).not.toThrow();
  });

  test("maps conventional types to release levels", () => {
    expect(expectedReleaseType("feat: add project discovery", "0.1.0")).toBe("minor");
    expect(expectedReleaseType("fix: retain output", "0.1.0")).toBe("patch");
    expect(expectedReleaseType("refactor!: replace snapshot API", "0.1.0")).toBe("minor");
    expect(expectedReleaseType("refactor!: replace snapshot API", "1.2.0")).toBe("major");
  });

  test("rejects prose summaries", () => {
    expect(() => getConventionalSummary("Improve project discovery.")).toThrow(
      "Summary must start with",
    );
  });

  test("rejects inconsistent release levels", () => {
    const contents = `---
"stackyard": patch
---

feat: add project discovery
`;

    expect(() =>
      validateChangeset("project-discovery.md", contents, new Map([["stackyard", "0.1.0"]])),
    ).toThrow("requires a minor release");
  });
});
