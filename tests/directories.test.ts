import { expect, test } from "bun:test";

import { resolveStackyardDirectories } from "../apps/daemon/src/directories.ts";

test("Windows keeps durable and runtime state in local application data", () => {
  expect(
    resolveStackyardDirectories({
      environment: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      homeDirectory: "C:\\Users\\Ada",
      platform: "win32",
    }),
  ).toEqual({
    data: "C:\\Users\\Ada\\AppData\\Local\\Stackyard",
    runtime: "C:\\Users\\Ada\\AppData\\Local\\Stackyard",
  });
});

test("Windows falls back to the conventional local application data directory", () => {
  expect(
    resolveStackyardDirectories({
      environment: {},
      homeDirectory: "C:\\Users\\Ada",
      platform: "win32",
    }),
  ).toEqual({
    data: "C:\\Users\\Ada\\AppData\\Local\\Stackyard",
    runtime: "C:\\Users\\Ada\\AppData\\Local\\Stackyard",
  });
});

test("macOS keeps durable state in Application Support", () => {
  expect(
    resolveStackyardDirectories({
      environment: {},
      homeDirectory: "/Users/ada",
      platform: "darwin",
    }),
  ).toEqual({
    data: "/Users/ada/Library/Application Support/Stackyard",
    runtime: "/Users/ada/.stackyard/run",
  });
});

test("Linux honors absolute XDG state and runtime directories", () => {
  expect(
    resolveStackyardDirectories({
      environment: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_STATE_HOME: "/home/ada/state",
      },
      homeDirectory: "/home/ada",
      platform: "linux",
    }),
  ).toEqual({
    data: "/home/ada/state/stackyard",
    runtime: "/run/user/1000/stackyard",
  });
});

test("relative XDG directories are ignored", () => {
  expect(
    resolveStackyardDirectories({
      environment: {
        XDG_RUNTIME_DIR: "runtime",
        XDG_STATE_HOME: "state",
      },
      homeDirectory: "/home/ada",
      platform: "linux",
    }),
  ).toEqual({
    data: "/home/ada/.local/state/stackyard",
    runtime: "/home/ada/.stackyard/run",
  });
});

test("Stackyard overrides resolve from the current directory", () => {
  expect(
    resolveStackyardDirectories({
      currentDirectory: "/work/project",
      environment: {
        STACKYARD_DATA_DIR: "data",
        STACKYARD_RUNTIME_DIR: "runtime",
      },
      homeDirectory: "/home/ada",
      platform: "linux",
    }),
  ).toEqual({
    data: "/work/project/data",
    runtime: "/work/project/runtime",
  });
});

test("explicit overrides take precedence over environment overrides", () => {
  expect(
    resolveStackyardDirectories({
      currentDirectory: "/work/project",
      dataOverride: "/explicit/data",
      environment: {
        STACKYARD_DATA_DIR: "/environment/data",
        STACKYARD_RUNTIME_DIR: "/environment/runtime",
      },
      homeDirectory: "/home/ada",
      platform: "linux",
      runtimeOverride: "/explicit/runtime",
    }),
  ).toEqual({ data: "/explicit/data", runtime: "/explicit/runtime" });
});
