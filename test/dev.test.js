// Runs dev.sh for real against a copy of the build inputs, with a stub in place of SilverBullet.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "tlo-dev-"));
  for (const path of ["dev.sh", "build.sh", "LICENSE", "package.json", "src", "Library"]) cpSync(join(repo, path), join(dir, path), { recursive: true });
  mkdirSync(join(dir, "dist/lib"), { recursive: true });
  writeFileSync(join(dir, "dist/lib/editor.js"), "// editor\n");
  // Records its arguments and pid, then serves until stopped.
  const stub = join(dir, "stub-silverbullet");
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" > "${dir}/server-args"\necho $$ > "${dir}/server-pid"\n[ -z "\${STUB_DIES:-}" ] || exit 1\nexec sleep 60\n`);
  chmodSync(stub, 0o755);
  return dir;
}

function run(dir, env = {}) {
  const child = spawn("./dev.sh", { cwd: dir, env: { ...process.env, TLO_SILVERBULLET: join(dir, "stub-silverbullet"), ...env } });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  child.done = new Promise((resolve) => child.on("close", resolve));
  return child;
}

async function started(dir, env) {
  const child = run(dir, env);
  await until(() => child.output.includes("Dev space on"), "the dev server to start");
  return child;
}

async function stop(child) {
  child.kill("SIGTERM");
  await child.done;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const space = (dir, path) => join(dir, ".dev/space", path);
const read = (dir, path) => readFileSync(space(dir, path), "utf8");

test("a first start seeds a page per app, installs the plug and serves the space", async () => {
  const dir = checkout();
  const child = await started(dir, { TLO_DEV_PORT: "3456" });
  try {
    assert.match(read(dir, "App/sheet.md"), /```tlo\n---\napp: sheet\n---\n```/);
    assert.match(read(dir, "App/trip.md"), /app: trip/);
    assert.match(read(dir, "index.md"), /\[\[App\/write\]\]/);
    assert.match(read(dir, "Dev Reload.md"), /Library\/tlo\/tlo\.md/);
    assert.ok(existsSync(space(dir, "Library/tlo/tlo.plug.js")));
    assert.ok(existsSync(space(dir, "Library/tlo/editor.js")));
    await until(() => existsSync(join(dir, "server-args")), "the server to run");
    assert.equal(readFileSync(join(dir, "server-args"), "utf8").trim(), `--single -L 127.0.0.1 -p 3456 ${join(dir, ".dev/space")}`);
  } finally { await stop(child); }
});

test("a restart keeps pages edited in the dev space", async () => {
  const dir = checkout();
  await stop(await started(dir));
  writeFileSync(space(dir, "App/sheet.md"), "my edits\n");
  await stop(await started(dir));
  assert.equal(read(dir, "App/sheet.md"), "my edits\n");
});

test("a source change reaches the space, leaves the editors alone and changes the page tabs reload on", async () => {
  const dir = checkout();
  const child = await started(dir);
  try {
    const page = read(dir, "Library/tlo/tlo.md");
    const editor = statSync(space(dir, "Library/tlo/editor.js")).mtimeMs;
    writeFileSync(join(dir, "src/widget.css"), "/* changed */\n");
    await until(() => read(dir, "Library/tlo/tlo.plug.js").includes("/* changed */") && read(dir, "Library/tlo/tlo.md") !== page, "the rebuild");
    assert.equal(statSync(space(dir, "Library/tlo/editor.js")).mtimeMs, editor);
  } finally { await stop(child); }
});

test("rebuilt editors replace the old files in the space", async () => {
  const dir = checkout();
  const child = await started(dir);
  try {
    rmSync(join(dir, "dist/lib/editor.js"));
    writeFileSync(join(dir, "dist/lib/editor2.js"), "// editor\n");
    await until(() => existsSync(space(dir, "Library/tlo/editor2.js")) && !existsSync(space(dir, "Library/tlo/editor.js")), "the new editors");
  } finally { await stop(child); }
});

test("a failed build keeps serving the last plug and recovers on the next change", async () => {
  const dir = checkout();
  const child = await started(dir);
  try {
    const plug = read(dir, "Library/tlo/tlo.plug.js");
    const fence = readFileSync(join(dir, "src/fence.js"), "utf8");
    rmSync(join(dir, "src/fence.js"));
    await until(() => child.output.includes("build failed"), "the failure report");
    assert.equal(read(dir, "Library/tlo/tlo.plug.js"), plug);
    assert.equal(child.exitCode, null);
    writeFileSync(join(dir, "src/fence.js"), `${fence}// back\n`);
    await until(() => read(dir, "Library/tlo/tlo.plug.js").includes("// back"), "the recovery");
  } finally { await stop(child); }
});

test("stopping the dev server stops SilverBullet", async () => {
  const dir = checkout();
  const child = await started(dir);
  await until(() => existsSync(join(dir, "server-pid")), "the server to run");
  const pid = Number(readFileSync(join(dir, "server-pid"), "utf8"));
  assert.ok(alive(pid));
  await stop(child);
  await until(() => !alive(pid), "SilverBullet to stop");
});

test("the dev server exits with a hint when SilverBullet cannot run", async () => {
  const dir = checkout();
  const child = run(dir, { STUB_DIES: "1" });
  assert.equal(await child.done, 1);
  assert.match(child.output, /is port 3000 in use/);
});

test("a missing SilverBullet names the command that fetches it", async () => {
  const dir = checkout();
  const child = run(dir, { TLO_SILVERBULLET: join(dir, "nothing") });
  assert.equal(await child.done, 1);
  assert.match(child.output, /run test\/fetch-tools\.sh/);
});

test("missing editors name the command that builds them", async () => {
  const dir = checkout();
  rmSync(join(dir, "dist/lib"), { recursive: true });
  const child = run(dir);
  assert.equal(await child.done, 1);
  assert.match(child.output, /run \.\/build-lib\.sh/);
});
