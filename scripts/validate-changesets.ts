type ReleaseType = "major" | "minor" | "patch";
type ConventionalType = "deps" | "docs" | "feat" | "fix" | "perf" | "refactor";

type ChangesetRelease = {
  name: string;
  type: ReleaseType;
};

type ParsedChangeset = {
  releases: ChangesetRelease[];
  summary: string;
};

const conventionalSummaryPattern =
  /^(feat|fix|perf|refactor|docs|deps)(?:\([a-z0-9][a-z0-9._/-]*\))?(!)?: .+$/;
const metadataPattern =
  /^(?:(?:pr|pull|pull request):\s*#?\d+|commit:\s*\S+|(?:author|user):\s*@?\S+)$/i;
const releasePattern = /^(?:"([^"]+)"|'([^']+)'|([^:]+)):\s*(major|minor|patch)$/;

function isReleaseType(value: string | undefined): value is ReleaseType {
  return value === "major" || value === "minor" || value === "patch";
}

function isConventionalType(value: string | undefined): value is ConventionalType {
  return (
    value === "deps" ||
    value === "docs" ||
    value === "feat" ||
    value === "fix" ||
    value === "perf" ||
    value === "refactor"
  );
}

export function parseChangeset(contents: string): ParsedChangeset {
  const lines = contents.replaceAll("\r\n", "\n").split("\n");

  if (lines[0] !== "---") {
    throw new Error('Changeset must start with "---".');
  }

  const closingIndex = lines.indexOf("---", 1);

  if (closingIndex === -1) {
    throw new Error('Changeset frontmatter is missing its closing "---".');
  }

  const releases = lines.slice(1, closingIndex).flatMap((line) => {
    if (line.trim().length === 0) {
      return [];
    }

    const match = line.match(releasePattern);

    if (!match) {
      throw new Error(`Invalid release entry: ${line}`);
    }

    const name = match[1] ?? match[2] ?? match[3];
    const type = match[4];

    if (!name) {
      throw new Error(`Invalid package name in release entry: ${line}`);
    }

    if (!isReleaseType(type)) {
      throw new Error(`Invalid release type: ${type}`);
    }

    return [
      {
        name: name.trim(),
        type,
      },
    ];
  });

  return {
    releases,
    summary: lines
      .slice(closingIndex + 1)
      .join("\n")
      .trim(),
  };
}

export function getConventionalSummary(summary: string): {
  breaking: boolean;
  line: string;
  type: ConventionalType;
} {
  const line = summary
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !metadataPattern.test(candidate));

  if (!line) {
    throw new Error("Non-empty Changeset must have a summary.");
  }

  const match = line.match(conventionalSummaryPattern);

  if (!match) {
    throw new Error(
      `Summary must start with feat:, fix:, perf:, refactor:, docs:, deps:, or a breaking ! variant: ${line}`,
    );
  }

  const type = match[1];

  if (!isConventionalType(type)) {
    throw new Error(`Unsupported Changeset type: ${type}`);
  }

  return {
    breaking: match[2] === "!",
    line,
    type,
  };
}

export function expectedReleaseType(summary: string, currentVersion: string): ReleaseType {
  const conventional = getConventionalSummary(summary);
  const major = Number(currentVersion.split(".", 1)[0]);

  if (!Number.isInteger(major) || major < 0) {
    throw new Error(`Invalid package version: ${currentVersion}`);
  }

  if (conventional.breaking) {
    return major === 0 ? "minor" : "major";
  }

  return conventional.type === "feat" ? "minor" : "patch";
}

export function validateChangeset(
  filename: string,
  contents: string,
  packageVersions: ReadonlyMap<string, string>,
): void {
  const changeset = parseChangeset(contents);

  if (changeset.releases.length === 0) {
    return;
  }

  const conventional = getConventionalSummary(changeset.summary);

  for (const release of changeset.releases) {
    const currentVersion = packageVersions.get(release.name);

    if (!currentVersion) {
      throw new Error(`${filename}: package not found: ${release.name}`);
    }

    const expected = expectedReleaseType(changeset.summary, currentVersion);

    if (release.type !== expected) {
      throw new Error(
        `${filename}: ${conventional.line} requires a ${expected} release for ${release.name}@${currentVersion}, not ${release.type}.`,
      );
    }
  }
}

async function loadPackageVersions(): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const patterns = [
    "package.json",
    "apps/*/package.json",
    "packages/*/package.json",
    "examples/*/package.json",
  ];

  const paths = (
    await Promise.all(
      patterns.map((pattern) => Array.fromAsync(new Bun.Glob(pattern).scan({ onlyFiles: true }))),
    )
  ).flat();
  const manifests = await Promise.all(
    paths.map(async (path) => {
      const manifest: unknown = await Bun.file(path).json();
      return manifest;
    }),
  );

  for (const manifest of manifests) {
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      "version" in manifest &&
      typeof manifest.name === "string" &&
      typeof manifest.version === "string"
    ) {
      versions.set(manifest.name, manifest.version);
    }
  }

  return versions;
}

async function main(): Promise<void> {
  const packageVersions = await loadPackageVersions();
  const filenames = await Array.fromAsync(
    new Bun.Glob("*.md").scan({
      cwd: ".changeset",
      onlyFiles: true,
    }),
  );
  const results = await Promise.all(
    filenames.map(async (filename) => {
      try {
        validateChangeset(
          filename,
          await Bun.file(`.changeset/${filename}`).text(),
          packageVersions,
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  );
  const errors = results.filter((message): message is string => message !== null);

  if (errors.length > 0) {
    throw new Error(`Invalid Changesets:\n- ${errors.join("\n- ")}`);
  }

  console.log(`Validated ${filenames.length} Changeset${filenames.length === 1 ? "" : "s"}.`);
}

if (import.meta.main) {
  await main();
}
