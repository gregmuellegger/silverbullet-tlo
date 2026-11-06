import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

function publish(tag, pageVersion) {
  const plug = mkdtempSync(join(tmpdir(), "tlo-publish-"));
  writeFileSync(join(plug, "tlo.md"), `---\nversion: ${pageVersion}\n---\n`);
  return spawnSync("scripts/publish.sh", [plug], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: "nobody/nothing", GH_TOKEN: "unused", RUNNER_TEMP: tmpdir() },
  });
}

test("a tag that differs from package.json's version publishes nothing", () => {
  const result = publish("v0.0.0-other", version);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match package.json version/);
});

test("a built library of another version publishes nothing", () => {
  const result = publish(`v${version}`, "0.0.0-other");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not version/);
});
