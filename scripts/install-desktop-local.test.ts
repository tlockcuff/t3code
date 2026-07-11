import { assert, describe, it } from "@effect/vitest";

import {
  macQuitAppAppleScript,
  resolveBuiltAppPath,
  resolveInstalledAppPath,
} from "./install-desktop-local.ts";
import { resolveMacAppBundlePaths } from "./build-desktop-artifact.ts";

const joinPath = (...parts: string[]) => parts.join("/");

describe("install-desktop-local", () => {
  it("resolves the Applications install path from the product name", () => {
    assert.equal(
      resolveInstalledAppPath(joinPath, "/Applications", "T3 Code (Alpha)"),
      "/Applications/T3 Code (Alpha).app",
    );
  });

  it("resolves the built dir-target app path from the product name", () => {
    assert.equal(
      resolveBuiltAppPath(joinPath, "/repo/release", "T3 Code (Alpha)"),
      "/repo/release/T3 Code (Alpha).app",
    );
  });

  it("escapes AppleScript quotes in the quit command", () => {
    assert.equal(
      macQuitAppAppleScript('T3 Code "Alpha"'),
      'tell application "T3 Code \\"Alpha\\"" to quit',
    );
    assert.equal(
      macQuitAppAppleScript("T3 Code (Alpha)"),
      'tell application "T3 Code (Alpha)" to quit',
    );
  });
});

describe("resolveMacAppBundlePaths", () => {
  it("finds nested mac-* app bundles for dir targets", () => {
    assert.deepStrictEqual(
      resolveMacAppBundlePaths(
        joinPath,
        "/stage/dist",
        ["builder-debug.yml", "mac-arm64"],
        new Map([["mac-arm64", ["T3 Code (Alpha).app", "LICENSE.electron.txt"]]]),
      ),
      ["/stage/dist/mac-arm64/T3 Code (Alpha).app"],
    );
  });

  it("finds top-level app bundles when present", () => {
    assert.deepStrictEqual(
      resolveMacAppBundlePaths(
        joinPath,
        "/stage/dist",
        ["T3 Code (Alpha).app", "builder-debug.yml"],
        new Map(),
      ),
      ["/stage/dist/T3 Code (Alpha).app"],
    );
  });

  it("ignores non-mac directories", () => {
    assert.deepStrictEqual(
      resolveMacAppBundlePaths(
        joinPath,
        "/stage/dist",
        ["linux-unpacked", "builder-debug.yml"],
        new Map([["linux-unpacked", ["t3code"]]]),
      ),
      [],
    );
  });
});
