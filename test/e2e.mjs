#!/usr/bin/env node
// End-to-end check in real headless Chrome, with no dependencies: Node's WebSocket drives the DevTools protocol.
// Starts a throwaway SilverBullet space, installs dist/plug with SilverBullet's library installer, then edits documents through the widget.
// Needs: dist/plug (npm run build) and .tools/ (test/fetch-tools.sh), or TLO_SILVERBULLET and TLO_CHROME pointing at the binaries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const plug = join(repo, "dist/plug");
const silverbullet = process.env.TLO_SILVERBULLET ?? join(repo, ".tools/silverbullet");
const chrome = process.env.TLO_CHROME ?? join(repo, ".tools/chrome-headless-shell-linux64/chrome-headless-shell");
const SB_PORT = 3210, CDP_PORT = 9333, RAW_PORT = 3211;
const SB = `http://127.0.0.1:${SB_PORT}`;
const shots = process.env.TLO_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const only = process.env.TLO_ONLY && new RegExp(process.env.TLO_ONLY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await check(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

const children = [];
const start = (cmd, args, env = {}) => {
  const child = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, ...env } });
  children.push(child);
  return child;
};

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.calls = new Map(); this.contexts = new Map(); this.logs = []; this.warnings = []; this.dialogs = []; this.stay = false; this.requests = [];
    ws.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { const c = this.calls.get(m.id); this.calls.delete(m.id); m.error ? c.reject(new Error(m.error.message)) : c.resolve(m.result); }
      else if (m.method === "Runtime.executionContextCreated") { const c = m.params.context; if (c.auxData?.isDefault) this.contexts.set(c.auxData.frameId, c.id); }
      else if (m.method === "Network.requestWillBeSent") this.requests.push(m.params.request.url);
      else if (m.method === "Page.javascriptDialogOpening") { this.dialogs.push(m.params.type); this.send("Page.handleJavaScriptDialog", { accept: !this.stay }); }
      else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "warning") this.warnings.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
      else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.logs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
      else if (m.method === "Runtime.exceptionThrown") this.logs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.calls.set(id, { resolve, reject })); }
  async eval(expression, contextId) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  /** Frames whose URL matches, in document order. */
  async frames(pattern) {
    const { frameTree } = await this.send("Page.getFrameTree");
    const all = [];
    const walk = (n) => { all.push(n.frame); (n.childFrames ?? []).forEach(walk); };
    walk(frameTree);
    return all.filter((f) => pattern.test(f.url));
  }
  async inFrame(frame, expression) { return this.eval(expression, this.contexts.get(frame.id)); }
  async shot(name) { if (!shots) return; const { data } = await this.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64")); }
}

const results = [];
let onFailure;
async function scenario(name, fn) {
  if (only && !only.test(name) && !name.startsWith("the library installs")) return; // Every other scenario needs the install.
  try { await fn(); results.push(true); console.log(`ok   ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}\n     ${e.message}`); await onFailure?.(name); }
}

const APPS = ["write", "outline", "deck", "sheet", "calc", "draw", "diagram", "anim", "cal", "trip"];
const appPage = (app) => `# ${app}\n\n\`\`\`tlo\n---\napp: ${app}\n---\n\`\`\`\n\nend\n`;
const brokenPage = "# Broken\n\n```tlo\n---\napp: nonsense\n---\nwords\n```\n\nend\n";

const space = mkdtempSync(join(tmpdir(), "tlo-e2e-"));
const pageFile = (name) => join(space, `${name}.md`);
const read = (name) => readFileSync(pageFile(name), "utf8");

async function main() {
  // Stands in for raw.githubusercontent.com: same content types, same 404s. The page below sends SilverBullet's github: reader here.
  const raw = createServer((req, res) => {
    const file = join(plug, decodeURIComponent(req.url).split("/").pop());
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": file.endsWith(".woff2") ? "application/octet-stream" : "text/plain; charset=utf-8" });
      res.end(body);
    } catch { res.writeHead(404); res.end("404: Not Found"); }
  }).listen(RAW_PORT, "127.0.0.1");
  children.push(raw);
  writeFileSync(pageFile("index"), "# Home\n");
  writeFileSync(pageFile("Raw"), `\`\`\`space-lua
service.define {
  selector = "net.readURI:github:*",
  match = { priority = 20 },
  run = function(data)
    local owner, repo, path = table.unpack(data.uri:sub(#"github:" + 1):split("/"))
    local res = net.proxyFetch("http://127.0.0.1:${RAW_PORT}/" .. path)
    if res.status != 200 then return nil end
    return res.body
  end
}
\`\`\`
`);
  writeFileSync(pageFile("Sheet"), "# Sheet\n\n```tlo\n---\napp: sheet\n---\nItem | Cost:money\n--- | ---\nRent | 1200\n```\n\nafter\n");
  writeFileSync(pageFile("Plain"), "before\n\n```tlo\nHello from markdown\n```\n\nafter\n");
  writeFileSync(pageFile("Twins"), "```tlo\nSame words\n```\n\nmiddle\n\n```tlo\nSame words\n```\n\nend\n");
  writeFileSync(pageFile("Paste"), "start\n\n\n\nend\n");
  mkdirSync(join(space, "Deep/Down"), { recursive: true });
  writeFileSync(pageFile("Deep/Down/Sheet"), "# Deep\n\n```tlo\n---\napp: sheet\n---\nA\n---\n1\n```\n\nend\n");
  for (const app of APPS) writeFileSync(pageFile(`App-${app}`), appPage(app));
  writeFileSync(pageFile("Broken"), brokenPage);
  for (const name of ["Live", "Fallback", "Enter", "Leave", "External", "Synced", "Revert", "Refresh", "Full", "Closing", "Closed", "RoPage", "NavLate", "NavEarly"]) writeFileSync(pageFile(name), "before\n\n```tlo\nHello from markdown\n```\n\nafter\n");
  writeFileSync(pageFile("Twins2"), "```tlo\nSame words\n```\n\nmiddle\n\n```tlo\nSame words\n```\n\nend\n");
  writeFileSync(pageFile("Twins3"), "```tlo\nPair A\n```\n\nmiddle\n\n```tlo\nPair AB\n```\n\nend\n");
  writeFileSync(pageFile("Long"), `start\n\n\`\`\`tlo\nHello long\n\`\`\`\n\n${Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n\n")}\n`);
  writeFileSync(pageFile("Tall"), Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n\n") + "\n");
  writeFileSync(pageFile("Listed"), "- item\n  ```tlo\n  Hello list\n  ```\n\nend\n");
  writeFileSync(pageFile("Nested"), "- a\n  - b\n    ```tlo\n    ---\n    app: write\n    ---\n    Hello nested\n    ```\n\nend\n");
  writeFileSync(pageFile("Indented"), "start\n\n  ```tlo\n  Hello two\n  ```\n\nend\n");
  writeFileSync(pageFile("TwinLong"), `\`\`\`tlo\nSame words\n\`\`\`\n\nmiddle\n\n\`\`\`tlo\nSame words\n\`\`\`\n\n${Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n\n")}\n`);
  writeFileSync(pageFile("TwinRemote"), "```tlo\nSame words\n```\n\nmiddle\n\n```tlo\nSame words\n```\n\nend\n");
  writeFileSync(pageFile("TwinShift"), "top\n\n```tlo\nSame words\n```\n\nmiddle\n\n```tlo\nSame words\n```\n\nend\n");
  writeFileSync(pageFile("TwinFull"), "```tlo\nA doc\n```\n\nmiddle\n\n```tlo\nB doc\n```\n\nend\n");
  writeFileSync(pageFile("Grow"), "before\n\n```tlo\nGROWDOC\n```\n\nafter\n");
  writeFileSync(pageFile("Tilde"), "x\n\n~~~tlo\nHello tildes\n~~~\n\ny\n");
  writeFileSync(pageFile("Linked"), `x\n\n\`\`\`tlo\nhttps://tinylittleoffice.com/write/#doc=${encodeURIComponent("Linked words")}\n\`\`\`\n\ny\n`);
  writeFileSync(pageFile("Mixed"), "```tlo\nOne\n```\n\nmiddle\n\n```lua\nprint(1)\n```\n\n```tlo\nTwo\n```\n\nend\n");

  start(silverbullet, ["--single", "-L", "127.0.0.1", "-p", String(SB_PORT), space]);
  start(chrome, ["--headless", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "tlo-chrome-"))}`, "--no-sandbox", "--window-size=1100,900", "about:blank"]);

  await until(() => fetch(`${SB}/.ping`).then((r) => r.ok), "SilverBullet");
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find((t) => t.type === "page"), "Chrome");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  const page = new Page(ws);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Page.setLifecycleEventsEnabled", { enabled: true });

  onFailure = async (name) => {
    await page.shot(`fail-${name.slice(0, 24).replace(/\W+/g, "-")}`);
    for (const f of await page.frames(/./)) {
      const text = await page.inFrame(f, `document.body?.innerText?.slice(0, 160)`).catch((e) => e.message);
      console.log(`     frame ${f.url.slice(0, 90)} :: ${JSON.stringify(text)}`);
    }
    console.log(page.logs.slice(-6).join("\n"));
  };

  const open = async (name) => {
    await page.send("Page.navigate", { url: `${SB}/${name}` });
    await until(() => page.eval(`!!globalThis.client?.editorView && client.currentName() === ${JSON.stringify(name)} && client.editorView.state.doc.length > 0`), `page ${name}`, 30000);
    await until(() => page.eval(`client.clientSystem.codeWidgetHook.codeWidgetCallbacks.has("tlo")`), "plug loaded", 30000);
  };
  const installPlug = async () => {
    await page.send("Page.navigate", { url: `${SB}/index` });
    await until(() => page.eval(`!!globalThis.client?.editorView && client.currentName() === "index"`), "home page", 30000);
    const uri = "github:owner/silverbullet-tlo@dist/tlo.md";
    await until(() => page.eval(`client.clientSystem.serviceRegistry.discover("net.readURI:${uri}").then((found) => found.some((s) => s.priority === 20))`).catch(() => false), "stand-in reader", 30000);
    return page.eval(`client.clientSystem.system.invokeFunction("configuration-manager.librariesAction", ["install", { uri: ${JSON.stringify(uri)} }])`);
  };
  // Widget frames holding the app's editor. A widget frame's URL is the page's, so ask each one.
  const appFrames = async (app) => {
    const found = [];
    for (const f of await page.frames(/./)) if (await page.inFrame(f, `!!document.querySelector("to-${app}-editor")`).catch(() => false)) found.push(f);
    return found;
  };
  const typeInto = (frame, text) => page.inFrame(frame, `(() => { const e = document.querySelector(${JSON.stringify(editableSelector)}); e.focus(); const s = getSelection(); s.selectAllChildren(e); s.collapseToEnd(); })()`).then(() => page.send("Input.insertText", { text }));
  const unsaved = () => until(async () => (await widgetStatus())?.startsWith("Unsaved"), "unsaved status");
  const settle = (name) => until(async () => (await widgetStatus()) === "Saved", `${name} to settle`, 20000);
  const widgetStatus = async () => {
    const fs = await page.frames(/./);
    for (const frame of fs) {
      const s = await page.inFrame(frame, `document.getElementById("tlo-status")?.textContent`).catch(() => null);
      if (s) return s;
    }
    return null;
  };
  const leaveWidget = async () => { await page.eval(`client.focus()`); };
  const editableSelector = `[contenteditable=true], [contenteditable=""], textarea`;

  await scenario("the library installs from its published files, byte for byte", async () => {
    const result = await installPlug();
    assert.equal(result.ok, true, JSON.stringify(result));
    const stamped = readFileSync(join(space, "Library/tlo/tlo.md"), "utf8");
    assert.ok(stamped.includes(`version: ${JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version}\n`), "page carries the version");
    assert.match(stamped, /share\.uri: "?github:owner\/silverbullet-tlo@dist\/tlo\.md/);
    const files = readdirSync(plug).filter((f) => f !== "tlo.md");
    assert.ok(files.length > 40, `${files.length} files`);
    for (const file of files) assert.ok(readFileSync(join(plug, file)).equals(readFileSync(join(space, "Library/tlo", file))), `${file} differs after install`);
  });

  await scenario("a tlo fence renders the sheet editor with the fence's data", async () => {
    await open("Sheet");
    const [frame] = await until(async () => { const f = await appFrames("sheet"); return f.length && f; }, "sheet frame");
    await until(() => page.inFrame(frame, `[...document.querySelectorAll("input, textarea, td, [role=gridcell]")].some((e) => (e.value ?? e.textContent).includes("Rent"))`), "sheet shows Rent");
    await settle("sheet");
    await page.shot("sheet");
    assert.ok(read("Sheet").includes("Rent | 1200"));
  });

  await scenario("opening a document leaves the focus in SilverBullet", async () => {
    assert.equal(await page.eval(`document.activeElement?.tagName`), "DIV");
    assert.ok(await page.eval(`document.activeElement.closest(".cm-editor") !== null`));
  });

  await scenario("opening a document writes nothing to the page", async () => {
    await sleep(1500);
    assert.equal(read("Sheet"), "# Sheet\n\n```tlo\n---\napp: sheet\n---\nItem | Cost:money\n--- | ---\nRent | 1200\n```\n\nafter\n");
  });

  await scenario("typing in the editor marks it unsaved, and leaving writes it into the fence", async () => {
    await open("Plain");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("write");
    await typeInto(frame, " EDITED");
    await unsaved();
    await page.shot("dirty");
    await leaveWidget();
    await until(() => read("Plain").includes("EDITED"), "EDITED on disk", 20000);
    const text = read("Plain");
    assert.match(text, /^before\n\n```tlo\n/);
    assert.match(text, /\n```\n\nafter\n$/);
    assert.match(text, /app: write/);
  });

  await scenario("the saved fence reopens with the edit in the editor", async () => {
    await open("Plain");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await until(() => page.inFrame(frame, `document.body.innerText.includes("EDITED")`), "edit shown");
  });

  await scenario("editing the fence text in Markdown updates the rendered document", async () => {
    await open("Plain");
    await settle("write");
    await page.eval(`(() => { const v = client.editorView; const t = v.state.doc.toString(); const i = t.indexOf("EDITED"); v.dispatch({ changes: { from: i, to: i + 6, insert: "SOURCED" } }); })()`);
    await until(async () => { const fs = await appFrames("write"); for (const f of fs) if (await page.inFrame(f, `document.body.innerText.includes("SOURCED")`).catch(() => false)) return true; }, "source edit shown");
  });

  await scenario("the Save button stores an edit without clicking elsewhere first", async () => {
    await open("Plain");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("write");
    await typeInto(frame, " BUTTON");
    await unsaved();
    const at = await page.inFrame(frame, `(() => { const b = document.getElementById("tlo-save").getBoundingClientRect(); const f = frameElement.getBoundingClientRect(); return { x: f.x + b.x + b.width / 2, y: f.y + b.y + b.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
    await until(() => read("Plain").includes("BUTTON"), "BUTTON on disk", 20000);
  });

  await scenario("identical fences each save into their own block", async () => {
    await open("Twins");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.toString().indexOf("middle") } })`);
    const frames = await until(async () => { const f = await appFrames("write"); return f.length === 2 && f; }, "two write frames");
    await sleep(1500);
    const tops = await Promise.all(frames.map((f) => page.inFrame(f, `frameElement.getBoundingClientRect().top`)));
    const second = frames[tops[0] > tops[1] ? 0 : 1];
    await typeInto(second, " SECOND");
    await sleep(600);
    await leaveWidget();
    await until(() => read("Twins").includes("SECOND"), "SECOND on disk", 20000);
    const text = read("Twins");
    assert.ok(text.indexOf("SECOND") > text.indexOf("middle"), `second block edited:\n${text}`);
    assert.ok(text.startsWith("```tlo\nSame words\n```"), `first block untouched:\n${text}`);
  });

  await scenario("a pasted TLO link becomes a fence and keeps its link form when edited", async () => {
    await open("Paste");
    const link = `https://tinylittleoffice.com/write/#doc=${encodeURIComponent("Pasted words")}`;
    await page.eval(`(() => { const v = client.editorView; v.focus(); v.dispatch({ changes: { from: 7, insert: ${JSON.stringify(link)} }, selection: { anchor: 7 + ${link.length} } }); })()`);
    await until(() => page.eval(`client.editorView.state.doc.toString().includes("\`\`\`tlo")`), "fence inserted");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.length } })`);
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await until(() => page.inFrame(frame, `document.body.innerText.includes("Pasted words")`), "pasted doc shown");
    await settle("pasted");
    await typeInto(frame, " more");
    await sleep(600);
    await leaveWidget();
    await until(() => read("Paste").includes("tinylittleoffice.com/write/#/v1/"), "updated link on disk", 20000);
    assert.notEqual(read("Paste").match(/https:\S+/)[0], link);
  });

  await scenario("Ctrl+S saves while the focus stays in the document", async () => {
    await open("Plain");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("write");
    await typeInto(frame, " KEYED");
    await unsaved();
    const key = { key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await until(() => read("Plain").includes("KEYED"), "KEYED on disk", 20000);
  });

  await scenario("Ctrl+Z undoes inside the document without a shell", async () => {
    await open("Plain");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("write");
    await typeInto(frame, " UNDONE");
    await unsaved();
    const key = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await until(() => page.inFrame(frame, `!document.querySelector("to-write-editor").innerText.includes("UNDONE")`), "text undone");
    await until(async () => (await widgetStatus()) === "Saved", "back to the stored document");
  });

  await scenario("the app's toolbar commands work without a shell", async () => {
    await open("Sheet");
    const [frame] = await until(async () => { const f = await appFrames("sheet"); return f.length && f; }, "sheet frame");
    await settle("sheet");
    const labels = await page.inFrame(frame, `[...document.querySelectorAll("to-bar button")].map((b) => b.title || b.getAttribute("aria-label") || b.textContent.trim())`);
    assert.ok(labels.length >= 5, `bar buttons: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /insert/i.test(l)), `an Insert button: ${JSON.stringify(labels)}`);
  });

  await scenario("a document on a page in a folder loads the library from the space root", async () => {
    await open("Deep/Down/Sheet");
    await until(async () => (await appFrames("sheet")).length, "sheet frame");
    await settle("nested sheet");
  });

  await scenario("every app mounts its editor and draws its document", async () => {
    for (const app of APPS) {
      await open(`App-${app}`);
      const [frame] = await until(async () => { const f = await appFrames(app); return f.length && f; }, `${app} editor`);
      await until(() => page.inFrame(frame, `document.querySelector("to-${app}-editor").children.length`), `${app} drawn`);
      await settle(app);
      await page.shot(`app-${app}`);
    }
    assert.deepEqual(page.logs.filter((l) => /Uncaught|TypeError|ReferenceError/.test(l) && !/openfreemap/.test(l)), []);
  });

  await scenario("opening every app leaves its page as it was", async () => {
    for (const app of APPS) assert.equal(read(`App-${app}`), appPage(app));
  });

  await scenario("a link fence converts to .tlo text on request", async () => {
    await open("Paste");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.length } })`);
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("link");
    await page.inFrame(frame, `document.getElementById("tlo-convert").click()`);
    await until(() => /app: write/.test(read("Paste")), ".tlo text on disk", 20000);
    assert.ok(!read("Paste").includes("https://tinylittleoffice.com"));
  });

  await scenario("TLO: Insert Document adds a fence that opens as the chosen app", async () => {
    await open("Paste");
    await page.eval(`(() => { client.focus(); client.editorView.dispatch({ selection: { anchor: 0 } }); void client.runCommandByName("TLO: Insert Document"); })()`);
    await until(() => page.eval(`!!document.activeElement?.closest(".sb-modal-box")`), "focus in the filter box");
    await page.send("Input.insertText", { text: "outline" });
    await sleep(300);
    for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until(() => page.eval(`client.editorView.state.doc.toString().includes("app: outline")`), "fence inserted");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.length } })`);
    await until(async () => (await appFrames("outline")).length, "outline editor");
  });

  await scenario("a body that names no known app says so and leaves the page alone", async () => {
    await open("Broken");
    await until(async () => /Not a Tiny Little Office app|Cannot open/.test((await widgetStatus()) ?? ""), "error status");
    assert.equal(read("Broken"), brokenPage);
  });

  await scenario("the document follows SilverBullet's dark theme", async () => {
    await open("Sheet");
    const [frame] = await until(async () => { const f = await appFrames("sheet"); return f.length && f; }, "sheet frame");
    await settle("sheet");
    await page.eval(`document.documentElement.dataset.theme = "dark"`);
    await until(() => page.inFrame(frame, `document.documentElement.dataset.theme === "dark"`), "dark widget");
    await page.shot("dark");
    await page.eval(`document.documentElement.dataset.theme = "light"`);
  });

  // ---- Live save: the write must leave the iframe alone.
  const writeFrame = async (name) => {
    await open(name);
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("write");
    return frame;
  };
  const mark = (frame, value = "kept") => page.inFrame(frame, `(() => { window.tloMark = ${JSON.stringify(value)}; frameElement.dataset.mark = ${JSON.stringify(value)}; })()`);
  const assertMarked = async (frame, value = "kept") => assert.deepEqual(await page.inFrame(frame, `[window.tloMark, frameElement?.dataset.mark, frameElement?.isConnected]`), [value, value, true], "same window, same iframe");
  const pageText = () => page.eval(`client.editorView.state.sliceDoc()`);
  const pressKey = async (key) => { for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, ...key }); };
  const ESCAPE = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
  const UNDO = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 };
  const editorFocused = (frame) => page.inFrame(frame, `(() => { const a = document.activeElement; return !!a && a !== document.body && !!a.closest("to-write-editor") && parent.document.activeElement === frameElement; })()`);
  const noExceptions = () => assert.deepEqual(page.logs.filter((l) => /Uncaught|TypeError|ReferenceError|RangeError/.test(l) && !/openfreemap/.test(l)), []);

  const notes = () => page.eval(`client.ui.viewState.notifications.map((n) => ({ type: n.type, message: n.message }))`);
  const assertLostEdit = async (name, words) => {
    await until(async () => (await notes()).some((n) => n.type === "error" && n.message.includes(name) && /console/.test(n.message)), `a notification naming ${name}`, 6000);
    assert.ok(page.warnings.some((w) => w.includes(name) && w.includes(words)), `console holds the text: ${JSON.stringify(page.warnings.slice(-3))}`);
  };

  await scenario("an edit reaches the disk while typing goes on, in the same iframe and at the same caret", async () => {
    const frame = await writeFrame("Live");
    await mark(frame);
    const before = await page.eval(`({ top: client.editorView.scrollDOM.scrollTop, selection: client.editorView.state.selection.main.head, frames: document.querySelectorAll("iframe[data-tlo]").length })`);
    await typeInto(frame, " FIRST");
    await unsaved();
    await until(() => read("Live").includes("FIRST"), "FIRST on disk", 20000);
    await assertMarked(frame);
    assert.equal(await editorFocused(frame), true, "focus stayed in the TLO editor");
    assert.equal(await widgetStatus(), "Saved");
    await page.send("Input.insertText", { text: " SECOND" });
    await until(() => read("Live").includes("FIRST SECOND"), "second burst on disk at the caret", 20000);
    await assertMarked(frame);
    assert.equal(await editorFocused(frame), true, "focus stayed after the second save");
    const after = await page.eval(`({ top: client.editorView.scrollDOM.scrollTop, selection: client.editorView.state.selection.main.head, frames: document.querySelectorAll("iframe[data-tlo]").length })`);
    assert.deepEqual(after, before, "page did not scroll, SilverBullet's cursor did not move");
    assert.match(read("Live"), /^before\n\n```tlo\n---\napp: write\n---\n/);
    assert.match(read("Live"), /\n```\n\nafter\n$/);
    noExceptions();
  });

  await scenario("the write waits for a pause in the typing, then happens once", async () => {
    const frame = await writeFrame("Live");
    await page.eval(`(() => { const v = client.editorView; globalThis.tloWrites = 0; v.dispatch = function (...args) { if (args[0]?.changes) tloWrites++; return Object.getPrototypeOf(v).dispatch.apply(v, args); }; })()`);
    await typeInto(frame, " a");
    for (const text of ["b", "c", "d", "e", "f"]) {
      await sleep(350);
      assert.ok(!(await pageText()).includes(" ab"), "nothing written while typing continues");
      await page.send("Input.insertText", { text });
    }
    const typedAt = Date.now();
    await until(async () => (await pageText()).includes(" abcdef"), "written after the pause", 3000);
    const waited = Date.now() - typedAt;
    assert.ok(waited >= 600 && waited < 1500, `written ${waited} ms after the last key`);
    await sleep(1200);
    assert.equal(await page.eval(`tloWrites`), 1, "one write for the whole burst");
    await page.eval(`delete client.editorView.dispatch`);
  });

  await scenario("leaving the document flushes at once, without waiting for the pause", async () => {
    const frame = await writeFrame("Live");
    await typeInto(frame, " BLURRED");
    await leaveWidget();
    assert.ok((await pageText()).includes("BLURRED"), "already in the page when the focus has moved");
  });

  await scenario("Ctrl+S flushes at once and the Save button keeps the caret in the document", async () => {
    const frame = await writeFrame("Live");
    await mark(frame);
    await typeInto(frame, " KEYS");
    await pressKey({ key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 });
    await until(async () => (await pageText()).includes("KEYS"), "written by Ctrl+S", 500);
    await page.send("Input.insertText", { text: " CLICK" });
    const at = await page.inFrame(frame, `(() => { const b = document.getElementById("tlo-save").getBoundingClientRect(); const f = frameElement.getBoundingClientRect(); return { x: f.x + b.x + b.width / 2, y: f.y + b.y + b.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
    await until(async () => (await pageText()).includes("KEYS CLICK"), "written by Save", 500);
    assert.equal(await editorFocused(frame), true, "caret still in the document");
    await assertMarked(frame);
  });

  await scenario("TLO's undo still works after a save, and the undo is saved too", async () => {
    const frame = await writeFrame("Live");
    await mark(frame);
    await typeInto(frame, " KEEP");
    await until(async () => (await pageText()).includes(" KEEP"), "first edit written");
    await sleep(1200);
    await page.send("Input.insertText", { text: " DROP" });
    await until(async () => (await pageText()).includes(" DROP"), "second edit written");
    await pressKey(UNDO);
    await until(() => page.inFrame(frame, `!document.querySelector("to-write-editor").innerText.includes("DROP")`), "undone in the editor");
    assert.ok(await page.inFrame(frame, `document.querySelector("to-write-editor").innerText.includes("KEEP")`), "earlier edit stays");
    await until(async () => !(await pageText()).includes("DROP"), "undo written to the fence");
    await until(() => !read("Live").includes("DROP"), "undo on disk", 20000);
    await assertMarked(frame);
  });

  await scenario("identical fences keep their own iframes and each save into their own block", async () => {
    await open("Twins2");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.toString().indexOf("middle") } })`);
    const frames = await until(async () => { const f = await appFrames("write"); return f.length === 2 && f; }, "two write frames");
    await sleep(1500);
    const tops = await Promise.all(frames.map((f) => page.inFrame(f, `frameElement.getBoundingClientRect().top`)));
    const [first, second] = tops[0] < tops[1] ? frames : [frames[1], frames[0]];
    await mark(first, "first");
    await mark(second, "second");
    await typeInto(second, " TWO");
    await until(() => read("Twins2").includes("TWO"), "second twin on disk", 20000);
    await assertMarked(first, "first");
    await assertMarked(second, "second");
    let text = read("Twins2");
    assert.ok(text.startsWith("```tlo\nSame words\n```"), `first block untouched:\n${text}`);
    assert.ok(text.indexOf("TWO") > text.indexOf("middle"), `second block edited:\n${text}`);
    await typeInto(first, " ONE");
    await until(() => read("Twins2").includes("ONE"), "first twin on disk", 20000);
    await typeInto(second, " THREE");
    await until(() => read("Twins2").includes("TWO THREE"), "second twin saves again", 20000);
    await assertMarked(first, "first");
    await assertMarked(second, "second");
    text = read("Twins2");
    assert.ok(text.indexOf("ONE") < text.indexOf("middle") && text.indexOf("THREE") > text.indexOf("middle"), text);
  });

  await scenario("identical fences that became identical through a save still resolve to the right block", async () => {
    await open("Twins3");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.toString().indexOf("middle") } })`);
    const frames = await until(async () => { const f = await appFrames("write"); return f.length === 2 && f; }, "two write frames");
    await sleep(1500);
    const texts = await Promise.all(frames.map((f) => page.inFrame(f, `document.querySelector("to-write-editor").innerText`)));
    const a = frames[texts.findIndex((t) => !t.includes("Pair AB"))], b = frames[texts.findIndex((t) => t.includes("Pair AB"))];
    await mark(a, "a");
    await mark(b, "b");
    await typeInto(a, "B");
    await until(() => (read("Twins3").match(/Pair AB/g) ?? []).length === 2, "A became identical to its twin", 20000);
    await typeInto(b, " MORE");
    await until(() => read("Twins3").includes("Pair AB MORE"), "second block edited", 20000);
    const text = read("Twins3");
    assert.ok(text.indexOf("MORE") > text.indexOf("middle"), `edit landed in its own block:\n${text}`);
    assert.ok(text.indexOf("Pair AB") < text.indexOf("middle"), `first block kept its edit:\n${text}`);
    await assertMarked(a, "a");
    await assertMarked(b, "b");
  });

  await scenario("when SilverBullet's internals are out of reach, the save still happens and the widget rebuilds", async () => {
    const frame = await writeFrame("Fallback");
    await mark(frame);
    await page.inFrame(frame, `Object.defineProperty(frameElement, "cmTile", { value: undefined, configurable: true, writable: true })`);
    await page.eval(`(() => { const E = client.editorView.constructor; globalThis.tloDecorations = E.decorations; E.decorations = undefined; })()`);
    try {
      await typeInto(frame, " REBUILT");
      await until(() => read("Fallback").includes("REBUILT"), "REBUILT on disk", 20000);
      const [rebuilt] = await until(async () => {
        const fs = await appFrames("write");
        for (const f of fs) if (await page.inFrame(f, `!window.tloMark && document.body.innerText.includes("REBUILT")`).catch(() => false)) return [f];
      }, "a rebuilt widget showing the saved text");
      await settle("rebuilt widget");
      await typeInto(rebuilt, " AGAIN");
      await until(() => read("Fallback").includes("REBUILT AGAIN"), "the rebuilt widget saves too", 20000);
    } finally {
      await page.eval(`client.editorView.constructor.decorations = globalThis.tloDecorations`);
    }
    noExceptions();
  });

  await scenario("a document scrolled out of view keeps the edit typed just before", async () => {
    await open("Long");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("long");
    await mark(frame);
    await typeInto(frame, " SCROLLED");
    await page.eval(`(() => { const s = client.editorView.scrollDOM; s.scrollTop = s.scrollHeight; })()`);
    await until(() => page.eval(`document.querySelectorAll("iframe[data-tlo]").length === 0`), "iframe unmounted", 3000);
    await until(async () => (await pageText()).includes("SCROLLED"), "edit written after the unmount", 3000);
    await until(() => read("Long").includes("SCROLLED"), "edit on disk", 20000);
    await page.eval(`client.editorView.scrollDOM.scrollTop = 0`);
    await until(async () => { for (const f of await appFrames("write")) if (await page.inFrame(f, `document.body.innerText.includes("SCROLLED")`).catch(() => false)) return true; }, "back in view with the edit");
    noExceptions();
  });

  await scenario("the cursor entering the fence keeps the edit typed just before", async () => {
    const frame = await writeFrame("Enter");
    await typeInto(frame, " ENTERED");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.sliceDoc().indexOf("Hello") } })`);
    await until(async () => (await pageText()).includes("ENTERED"), "edit written", 3000);
    await until(() => read("Enter").includes("ENTERED"), "edit on disk", 20000);
    noExceptions();
  });

  await scenario("navigating away with the focus in the document keeps the edit typed just before", async () => {
    const frame = await writeFrame("Leave");
    await typeInto(frame, " LEFT");
    await page.eval(`void client.navigate({ path: "index.md" })`);
    await until(() => page.eval(`client.currentName() === "index"`), "index open");
    await until(() => read("Leave").includes("LEFT"), "edit on disk", 20000);
    assert.match(read("index"), /^# Home/);
    assert.ok(!read("index").includes("LEFT"), "nothing written into the next page");
  });

  await scenario("going back in history with the focus in the document keeps the edit too", async () => {
    await open("index");
    await page.eval(`void client.navigate({ path: "Leave.md" })`);
    await until(() => page.eval(`client.currentName() === "Leave"`), "Leave open");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("write");
    await typeInto(frame, " BACK");
    await page.eval(`history.back()`);
    await until(() => page.eval(`client.currentName() === "index"`), "index open");
    await until(() => read("Leave").includes("LEFT BACK"), "edit on disk", 20000);
    assert.ok(!read("index").includes("BACK"), "nothing written into the next page");
  });

  await scenario("a change to the fence source reaches the widget and is not overwritten by stale text", async () => {
    const frame = await writeFrame("External");
    await mark(frame);
    await typeInto(frame, " STALE");
    await page.eval(`(() => { const v = client.editorView; const i = v.state.sliceDoc().indexOf("Hello"); v.dispatch({ changes: { from: i, to: i + 5, insert: "Changed" } }); })()`);
    await until(async () => { for (const f of await appFrames("write")) if (await page.inFrame(f, `document.body.innerText.includes("Changed")`).catch(() => false)) return true; }, "new body shown");
    await sleep(1500);
    const text = await pageText();
    assert.ok(text.includes("Changed"), text);
    assert.ok(!text.includes("STALE"), `stale text stayed out:\n${text}`);
    assert.ok(!text.includes("Hello"), text);
    await assertLostEdit("External", "STALE");
  });

  await scenario("a change arriving from disk after a live save rebuilds the widget, which then saves over the new text", async () => {
    const frame = await writeFrame("Synced");
    await mark(frame);
    await typeInto(frame, " LOCAL");
    await until(() => read("Synced").includes("LOCAL"), "live save on disk", 20000);
    await until(() => page.eval(`!client.ui.viewState.unsavedChanges`), "page saved");
    writeFileSync(pageFile("Synced"), read("Synced").replace("LOCAL", "REMOTE"));
    await page.eval(`client.contentManager.reloadPageContent()`);
    await until(async () => (await pageText()).includes("REMOTE"), "external text in the editor", 20000);
    const rebuilt = await until(async () => { for (const f of await appFrames("write")) if (await page.inFrame(f, `!window.tloMark && document.body.innerText.includes("REMOTE") && document.getElementById("tlo-status").textContent === "Saved"`).catch(() => false)) return f; }, "widget shows the external text");
    await typeInto(rebuilt, " THEN");
    await until(() => read("Synced").includes("REMOTE THEN"), "edit on top of the external text", 20000);
    assert.ok(!read("Synced").includes("LOCAL"));
  });

  await scenario("SilverBullet's undo reverts a live save and the widget follows", async () => {
    const frame = await writeFrame("Revert");
    await typeInto(frame, " REVERTME");
    await until(async () => (await pageText()).includes("REVERTME"), "written");
    await page.eval(`(() => { const v = client.editorView; client.focus(); })()`);
    await sleep(200);
    await pressKey(UNDO);
    await until(async () => !(await pageText()).includes("REVERTME"), "fence reverted");
    await until(async () => { const fs = await appFrames("write"); for (const f of fs) if (await page.inFrame(f, `!document.querySelector("to-write-editor").innerText.includes("REVERTME")`).catch(() => false)) return f; }, "widget shows the reverted text");
  });

  await scenario("Widgets: Refresh All keeps the saved text in the same window, and saving continues", async () => {
    const frame = await writeFrame("Refresh");
    await mark(frame);
    await typeInto(frame, " SAVED");
    await until(async () => (await pageText()).includes("SAVED"), "written");
    await page.eval(`void client.runCommandByName("Widgets: Refresh All")`);
    await until(() => page.inFrame(frame, `document.body.innerText.includes("SAVED") && document.getElementById("tlo-status").textContent === "Saved"`), "refreshed with the saved text");
    await assertMarked(frame);
    await until(() => page.inFrame(frame, `!!document.querySelector(${JSON.stringify(editableSelector)})`), "editor ready");
    await typeInto(frame, " MORE");
    await until(() => read("Refresh").includes("SAVED MORE"), "refreshed widget saves", 20000);
    assert.equal((read("Refresh").match(/SAVED/g) ?? []).length, 1);
  });

  await scenario("a tilde fence rewritten as backticks loses nothing", async () => {
    const frame = await writeFrame("Tilde");
    await mark(frame);
    await typeInto(frame, " TILDE");
    await until(() => read("Tilde").includes("TILDE"), "edit on disk", 20000);
    assert.match(read("Tilde"), /^x\n\n```tlo\n[\s\S]*TILDE\n```\n\ny\n$/);
    assert.equal(await widgetStatus(), "Saved");
    assert.equal(await page.inFrame(frame, `window.tloMark ?? "none"`).catch(() => "gone"), "kept", "the marker line changed and the iframe still stayed");
    noExceptions();
  });

  await scenario("a link fence converted to text stays text on the next edit, without a rebuild", async () => {
    await open("Linked");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("link");
    await mark(frame);
    await page.inFrame(frame, `document.getElementById("tlo-convert").click()`);
    await until(() => /app: write/.test(read("Linked")), ".tlo text on disk", 20000);
    await assertMarked(frame);
    await typeInto(frame, " AFTER");
    await until(() => read("Linked").includes("AFTER"), "edit on disk", 20000);
    assert.ok(!read("Linked").includes("https://"), read("Linked"));
  });

  // ---- Fix round: edits that could go missing, and fences that were not found.
  const clickPage = async () => { for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: 300, y: 200, button: "left", clickCount: 1 }); };
  const twoFrames = () => until(async () => { const f = await appFrames("write"); return f.length === 2 && f; }, "two write frames");
  const inOrder = async (frames) => { const tops = await Promise.all(frames.map((f) => page.inFrame(f, `frameElement.getBoundingClientRect().top`))); return tops[0] < tops[1] ? frames : [frames[1], frames[0]]; };
  const toMiddle = () => page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.toString().indexOf("middle") } })`);

  await scenario("closing the tab right after typing asks first, and staying stores the edit", async () => {
    const frame = await writeFrame("Closing");
    await clickPage();
    await typeInto(frame, " LASTWORDS");
    page.dialogs.length = 0;
    page.stay = true;
    await page.eval(`location.href = "about:blank"`).catch(() => {});
    await until(() => page.dialogs.includes("beforeunload"), "the leave dialog", 5000);
    page.stay = false;
    await until(() => read("Closing").includes("LASTWORDS"), "edit on disk after staying", 20000);
    assert.equal(await page.eval(`location.pathname`), "/Closing");
  });

  await scenario("closing the tab after a completed save does not ask, and the edit is on disk", async () => {
    const frame = await writeFrame("Closed");
    await clickPage();
    await typeInto(frame, " STORED");
    await until(() => read("Closed").includes("STORED"), "edit on disk", 20000);
    await until(() => page.eval(`!client.ui.viewState.unsavedChanges`), "page saved");
    page.dialogs.length = 0;
    await page.eval(`location.href = "about:blank"`).catch(() => {});
    await until(() => page.eval(`location.href === "about:blank"`), "left the page");
    assert.deepEqual(page.dialogs, []);
    assert.ok(read("Closed").includes("STORED"));
  });

  await scenario("a twin scrolled out right after typing writes into its own fence, with text added above it", async () => {
    await open("TwinLong");
    await toMiddle();
    const [, second] = await inOrder(await twoFrames());
    await sleep(1500);
    await page.eval(`client.editorView.dispatch({ changes: { from: 0, insert: "x".repeat(400) + "\\n\\n" } })`);
    await sleep(300);
    await typeInto(second, " MINE");
    await page.eval(`(() => { const s = client.editorView.scrollDOM; s.scrollTop = s.scrollHeight; })()`);
    await until(() => page.eval(`document.querySelectorAll("iframe[data-tlo]").length === 0`), "unmounted", 3000);
    await until(async () => (await pageText()).includes("MINE"), "edit written", 3000);
    const text = await pageText();
    assert.ok(text.indexOf("MINE") > text.indexOf("middle"), `landed in the second fence:\n${text.slice(400, 520)}`);
  });

  await scenario("an edit waiting when its fence changes remotely never lands on an identical twin", async () => {
    await open("TwinRemote");
    await toMiddle();
    const [first] = await inOrder(await twoFrames());
    await sleep(1500);
    await typeInto(first, " MINE");
    await page.eval(`(() => { const v = client.editorView; const i = v.state.sliceDoc().indexOf("Same"); v.dispatch({ changes: { from: i, to: i + 4, insert: "Remote" } }); })()`);
    await sleep(1200);
    const text = await pageText();
    assert.ok(!text.includes("MINE"), text);
    assert.equal(text, "```tlo\nRemote words\n```\n\nmiddle\n\n```tlo\nSame words\n```\n\nend\n");
    await assertLostEdit("TwinRemote", "MINE");
  });

  await scenario("text added above live twins never refuses their saves", async () => {
    await open("TwinShift");
    await toMiddle();
    const [first, second] = await inOrder(await twoFrames());
    await sleep(1500);
    await mark(second);
    await typeInto(second, " LATER");
    await page.eval(`client.editorView.dispatch({ changes: { from: 0, insert: "y".repeat(300) + "\\n\\n" } })`);
    await until(() => read("TwinShift").includes("LATER"), "edit on disk", 20000);
    await assertMarked(second);
    const text = read("TwinShift");
    assert.ok(text.indexOf("LATER") > text.indexOf("middle"), text);
    assert.equal(await page.inFrame(second, `document.getElementById("tlo-status").textContent`), "Saved");
    await typeInto(first, " EARLIER");
    await until(() => read("TwinShift").includes("EARLIER"), "first twin on disk", 20000);
  });

  for (const [name, indent, words] of [["Listed", "  ", "Hello list"], ["Indented", "  ", "Hello two"], ["Nested", "    ", "Hello nested"]]) {
    await scenario(`an indented fence saves repeatedly in the same iframe: ${name}`, async () => {
      await open(name);
      await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.length } })`);
      const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
      await until(() => page.inFrame(frame, `document.getElementById("tlo-status").textContent === "Saved" && document.querySelector("to-write-editor").innerText.includes(${JSON.stringify(words)})`), "opened with its words");
      await mark(frame);
      await typeInto(frame, " ONE");
      await until(() => read(name).includes("ONE"), "first save on disk", 6000);
      await typeInto(frame, " TWO");
      await until(() => read(name).includes("ONE TWO"), "second save on disk", 6000);
      await assertMarked(frame);
      assert.equal(await page.inFrame(frame, `document.getElementById("tlo-status").textContent`), "Saved");
      assert.ok(read(name).includes(`${indent}\`\`\`tlo\n${indent}---\n${indent}app: write\n${indent}---\n${indent}${words} ONE TWO\n${indent}\`\`\``), read(name));
    });
  }

  const delayNextRead = (ms) => page.eval(`(() => { const s = client.space; const r = s.readPage.bind(s); s.readPage = async (n) => { await new Promise((x) => setTimeout(x, ${ms})); delete s.readPage; return r(n); }; void client.navigate({ path: "index.md" }); })()`);

  await scenario("an edit typed while a page change runs, written too late for the page's last save, is reported", async () => {
    const frame = await writeFrame("NavLate");
    await page.inFrame(frame, `document.querySelector("[contenteditable=true]").focus()`);
    await delayNextRead(1500);
    await sleep(200);
    await page.send("Input.insertText", { text: " TOOLATE" });
    await until(() => page.eval(`client.currentName() === "index"`), "index open");
    await assertLostEdit("NavLate", "TOOLATE");
    assert.ok(!read("index").includes("TOOLATE"), "nothing written into the next page");
  });

  await scenario("an edit still waiting when the page changes is reported", async () => {
    const frame = await writeFrame("NavEarly");
    await page.inFrame(frame, `document.querySelector("[contenteditable=true]").focus()`);
    await delayNextRead(400);
    await sleep(150);
    await page.send("Input.insertText", { text: " TOOEARLY" });
    await until(() => page.eval(`client.currentName() === "index"`), "index open");
    await assertLostEdit("NavEarly", "TOOEARLY");
    assert.ok(!read("index").includes("TOOEARLY"), "nothing written into the next page");
  });

  await scenario("a read-only page says the edit was not saved", async () => {
    await open("RoPage");
    await page.eval(`client.ui.viewDispatch({ type: "update-current-page-meta", meta: { ...client.currentPageMeta(), perm: "ro" } })`);
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("read-only");
    await typeInto(frame, " ROEDIT");
    await until(async () => /read-only/.test(await page.inFrame(frame, `document.getElementById("tlo-status").textContent`)), "read-only status", 3000);
    assert.ok(!(await pageText()).includes("ROEDIT"), "the page buffer stays as it was");
  });

  await scenario("the height cache holds one entry per document, however many saves", async () => {
    const frame = await writeFrame("Grow");
    const entries = () => page.eval(`[...client.widgetCache.widgetMetaCache.map.keys()].filter((k) => k.includes("GROWDOC")).length`);
    for (let i = 0; i < 4; i++) {
      await typeInto(frame, ` e${i}`);
      await until(async () => (await pageText()).includes(` e${i}`), "written");
    }
    assert.ok((await entries()) <= 2, `entries: ${await entries()}`);
  });

  // ---- The copy button.
  const copyButtons = () => page.eval(`[...document.querySelectorAll(".cm-line")].flatMap((l) => [...l.querySelectorAll(".sb-code-copy-button")].map((b) => ({ tlo: !!l.querySelector("iframe[data-tlo]"), shown: b.getClientRects().length > 0 })))`);

  await scenario("the copy button is gone from tlo fences and stays on ordinary code fences", async () => {
    await open("Mixed");
    await page.eval(`client.editorView.dispatch({ selection: { anchor: client.editorView.state.doc.toString().indexOf("middle") } })`);
    await until(async () => (await appFrames("write")).length === 2, "two documents");
    await settle("mixed");
    await until(async () => { const b = await copyButtons(); return b.filter((x) => x.tlo).length === 2 && b.some((x) => !x.tlo); }, "buttons drawn");
    const buttons = await copyButtons();
    assert.deepEqual(buttons.filter((b) => b.tlo).map((b) => b.shown), [false, false], "hidden on tlo");
    assert.deepEqual(buttons.filter((b) => !b.tlo).map((b) => b.shown), [true], "shown on the lua block");
    assert.equal(await page.eval(`document.querySelectorAll("#tlo-host-style").length`), 1, "style added once for two widgets");
  });

  await scenario("a live save keeps the copy button hidden", async () => {
    const [frame] = await appFrames("write");
    await typeInto(frame, " X");
    await until(() => read("Mixed").includes(" X"), "edit on disk", 20000);
    const buttons = await copyButtons();
    assert.deepEqual(buttons.filter((b) => b.tlo).map((b) => b.shown), [false, false]);
    assert.equal(await page.eval(`document.querySelectorAll("#tlo-host-style").length`), 1);
  });

  // ---- Fullscreen.
  const rectOf = (expr) => page.eval(`(() => { const r = ${expr}.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const pressFull = async (frame) => {
    const at = await page.inFrame(frame, `(() => { const b = document.getElementById("tlo-full").getBoundingClientRect(); const f = frameElement.getBoundingClientRect(); return { x: f.x + b.x + b.width / 2 + frameElement.clientLeft, y: f.y + b.y + b.height / 2 + frameElement.clientTop }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
  };
  const fullLabel = (frame) => page.inFrame(frame, `document.getElementById("tlo-full").textContent`);
  const FRAME = `document.querySelector("iframe[data-tlo]")`;
  const AFTER_LINE = `[...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("after"))`;

  await scenario("Fullscreen enlarges over SilverBullet without moving the page, and Minimize restores the exact rect", async () => {
    const frame = await writeFrame("Full");
    await mark(frame);
    await typeInto(frame, " caret");
    await page.inFrame(frame, `document.querySelector("[contenteditable=true]").focus()`);
    const original = await rectOf(FRAME);
    const flowBefore = await rectOf(AFTER_LINE);
    const styleHeight = await page.eval(`${FRAME}.style.height`);
    assert.equal(await fullLabel(frame), "Fullscreen");
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "label Minimize");
    const big = await rectOf(FRAME);
    const view = await page.eval(`({ w: innerWidth, h: innerHeight })`);
    assert.ok(big.x >= 8 && big.x <= 32 && big.y >= 8 && big.y <= 32, `small margin: ${JSON.stringify(big)}`);
    assert.ok(Math.abs(big.x + big.w - (view.w - big.x)) <= 1 && Math.abs(big.y + big.h - (view.h - big.y)) <= 1, `even margins: ${JSON.stringify({ big, view })}`);
    assert.deepEqual(await rectOf(AFTER_LINE), flowBefore, "layout behind did not move");
    const top = await page.eval(`(() => { const r = ${FRAME}.getBoundingClientRect(); return [[r.x + 5, r.y + 5], [r.right - 5, r.y + 5], [r.x + r.width / 2, r.y + r.height / 2]].map(([x, y]) => document.elementFromPoint(x, y)?.tagName); })()`);
    assert.deepEqual(top, ["IFRAME", "IFRAME", "IFRAME"], "nothing of SilverBullet covers it");
    const doc = await page.inFrame(frame, `(() => { const d = document.querySelector("to-write-editor").getBoundingClientRect(); return { h: d.height, w: d.width, root: document.getElementById("tlo-root").getBoundingClientRect().height, win: innerHeight }; })()`);
    assert.ok(Math.abs(doc.root - doc.win) <= 2, `root fills the frame: ${JSON.stringify(doc)}`);
    await page.shot("enlarged");
    await assertMarked(frame);
    assert.equal(await editorFocused(frame), true, "caret stayed in the document");
    // Saving works here too.
    await page.send("Input.insertText", { text: " BIG" });
    await until(() => read("Full").includes("caret BIG"), "typed while enlarged, on disk", 20000);
    await assertMarked(frame);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "label Fullscreen");
    await sleep(300);
    assert.deepEqual(await rectOf(FRAME), original, "exact original rect");
    assert.deepEqual(await rectOf(AFTER_LINE), flowBefore, "layout unchanged after");
    assert.equal(await page.eval(`${FRAME}.style.height`), styleHeight);
    assert.equal(await page.eval(`document.documentElement.style.getPropertyValue("--tlo-held-height")`), "");
    await assertMarked(frame);
    assert.equal(await editorFocused(frame), true, "caret still in the document");
    await page.send("Input.insertText", { text: " SMALL" });
    await until(() => read("Full").includes("BIG SMALL"), "typing continues after minimizing", 20000);
  });

  await scenario("a dragged height survives enlarging, and the height cache never holds the enlarged size", async () => {
    const frame = await writeFrame("Full");
    await page.inFrame(frame, `document.getElementById("tlo-root").style.height = "700px"`);
    await until(async () => (await rectOf(FRAME)).h >= 700, "iframe follows the dragged height");
    const original = await rectOf(FRAME);
    const body = await page.inFrame(frame, `tloWidget.body`);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await page.inFrame(frame, `window.dispatchEvent(new Event("resize"))`);
    await sleep(500);
    const whileBig = await page.eval(`client.widgetCache.getCachedWidgetHeight(${JSON.stringify(body)})`);
    assert.ok(whileBig < 720, `cached height while enlarged: ${whileBig}`);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "minimized");
    await sleep(300);
    assert.deepEqual(await rectOf(FRAME), original);
    assert.equal(await page.inFrame(frame, `document.getElementById("tlo-root").style.height`), "700px");
    await page.inFrame(frame, `document.getElementById("tlo-root").style.height = ""`);
  });

  await scenario("a save while enlarged records the normal height, not the enlarged one", async () => {
    const frame = await writeFrame("Full");
    await page.inFrame(frame, `document.querySelector("[contenteditable=true]").focus()`);
    const normal = (await rectOf(FRAME)).h;
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await typeInto(frame, " H");
    await until(async () => (await widgetStatus()) === "Saved" && (await pageText()).includes(" H"), "saved");
    const body = await page.inFrame(frame, `tloWidget.body`);
    const cached = await page.eval(`client.widgetCache.getCachedWidgetHeight(${JSON.stringify(body)})`);
    assert.ok(Math.abs(cached - normal) <= 2, `cached ${cached}, normal ${normal}`);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "minimized");
  });

  await scenario("scrolling the page behind cannot unmount an enlarged document", async () => {
    await open("Long");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("long");
    await mark(frame);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    const top = await page.eval(`client.editorView.scrollDOM.scrollTop`);
    await page.eval(`(() => { const s = client.editorView.scrollDOM; s.scrollTop = s.scrollHeight; })()`);
    await sleep(800);
    assert.equal(await page.eval(`client.editorView.scrollDOM.scrollTop`), top, "scroller held still");
    await assertMarked(frame);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "minimized");
    await page.eval(`(() => { const s = client.editorView.scrollDOM; s.scrollTop = 40; })()`);
    await sleep(200);
    assert.equal(await page.eval(`client.editorView.scrollDOM.scrollTop`), 40, "scrolling is released afterwards");
  });

  await scenario("an enlarged document that goes away leaves the next page free to scroll", async () => {
    await open("Long");
    const [frame] = await until(async () => { const f = await appFrames("write"); return f.length && f; }, "write frame");
    await settle("long");
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await page.eval(`void client.navigate({ path: "Tall.md" })`);
    await until(() => page.eval(`client.currentName() === "Tall" && !document.querySelector("iframe[data-tlo]")`), "Tall open");
    assert.equal(await page.eval(`document.documentElement.style.getPropertyValue("--tlo-held-height")`), "");
    await until(() => page.eval(`client.editorView.scrollDOM.scrollHeight > 3000`), "a tall page drawn");
    await page.eval(`client.editorView.scrollDOM.scrollTop = 1500`);
    await sleep(500);
    // CodeMirror nudges the position as it measures lines, so check it stayed there, not at the exact pixel.
    assert.ok(Math.abs((await page.eval(`client.editorView.scrollDOM.scrollTop`)) - 1500) < 200, "the scroll hold is gone");
  });

  await scenario("Escape minimizes, and an open TLO menu or dialog takes it first", async () => {
    await open("Sheet");
    const [frame] = await until(async () => { const f = await appFrames("sheet"); return f.length && f; }, "sheet frame");
    await settle("sheet");
    await mark(frame);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await page.inFrame(frame, `document.querySelector("to-bar to-menu > button, to-bar [aria-haspopup]").click()`);
    await until(() => page.inFrame(frame, `!!document.querySelector(":popover-open:not(.to-context)")`), "menu open");
    await page.inFrame(frame, `document.querySelector(":popover-open:not(.to-context) button")?.focus()`);
    await pressKey(ESCAPE);
    await until(() => page.inFrame(frame, `!document.querySelector(":popover-open:not(.to-context)")`), "menu closed");
    assert.equal(await fullLabel(frame), "Minimize", "Escape closed the menu only");
    await page.inFrame(frame, `document.activeElement?.blur?.(); document.getElementById("tlo-status").tabIndex = -1; document.getElementById("tlo-status").focus()`);
    await pressKey(ESCAPE);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "second Escape minimizes");
    await assertMarked(frame);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged again");
    await page.inFrame(frame, `(() => { const d = document.createElement("dialog"); d.id = "probe"; document.body.append(d); d.showModal(); })()`);
    await pressKey(ESCAPE);
    await sleep(200);
    assert.equal(await fullLabel(frame), "Minimize", "an open dialog takes Escape");
    assert.equal(await page.inFrame(frame, `document.getElementById("probe").open`), false, "and the dialog closed");
    await page.inFrame(frame, `document.getElementById("probe").remove()`);
    // A press on the dimmed area puts the focus on the page, and Escape works from there too.
    for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: 6, y: 6, button: "left", clickCount: 1 });
    await until(() => page.eval(`document.activeElement?.tagName !== "IFRAME"`), "focus on the page");
    await pressKey(ESCAPE);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "Escape from the page side");
    await assertMarked(frame);
  });

  await scenario("an editor that uses every Escape cannot trap the document enlarged", async () => {
    await open("Sheet");
    const [frame] = await until(async () => { const f = await appFrames("sheet"); return f.length && f; }, "sheet frame");
    await settle("sheet");
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await page.inFrame(frame, `document.querySelector("to-sheet-editor input, to-sheet-editor [tabindex='0'], to-sheet-editor [contenteditable]")?.focus()`);
    await pressKey(ESCAPE);
    await sleep(150);
    const afterFirst = await fullLabel(frame);
    await pressKey(ESCAPE);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", `second Escape minimizes (after the first: ${afterFirst})`);
  });

  await scenario("Escape in the Write app with a caret minimizes and leaves the document as it was", async () => {
    const frame = await writeFrame("Full");
    const before = await pageText();
    await typeInto(frame, "");
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await pressKey(ESCAPE);
    await pressKey(ESCAPE);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "minimized");
    assert.equal(await pageText(), before);
  });

  await scenario("enlarging a second document minimizes the first, and both lines keep their height", async () => {
    await open("TwinFull");
    await toMiddle();
    const [first, second] = await inOrder(await twoFrames());
    await sleep(1500);
    const lines = `[...document.querySelectorAll(".cm-line")].filter((l) => l.querySelector("iframe[data-tlo]")).map((l) => l.getBoundingClientRect().height)`;
    const heights = await page.eval(lines);
    await pressFull(first);
    await until(async () => (await fullLabel(first)) === "Minimize", "first enlarged");
    await page.inFrame(second, `document.getElementById("tlo-full").click()`);
    await until(async () => (await fullLabel(second)) === "Minimize", "second enlarged");
    assert.equal(await fullLabel(first), "Fullscreen");
    assert.equal(await page.eval(`document.querySelectorAll("iframe[data-tlo-full]").length`), 1);
    assert.deepEqual(await page.eval(lines), heights, "line heights held");
    await page.inFrame(second, `document.getElementById("tlo-full").click()`);
    await until(async () => (await fullLabel(second)) === "Fullscreen", "second minimized");
    assert.deepEqual(await page.eval(lines), heights, "line heights after minimizing");
    assert.equal(await page.eval(`document.documentElement.style.getPropertyValue("--tlo-held-height")`), "");
  });

  await scenario("the enlarged document works in the dark theme", async () => {
    const frame = await writeFrame("Full");
    await page.eval(`document.documentElement.dataset.theme = "dark"`);
    await until(() => page.inFrame(frame, `document.documentElement.dataset.theme === "dark"`), "dark widget");
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Minimize", "enlarged");
    await sleep(200);
    await page.shot("enlarged-dark");
    const bg = await page.eval(`getComputedStyle(${FRAME}).backgroundColor`);
    assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(bg), `opaque background: ${bg}`);
    await pressFull(frame);
    await until(async () => (await fullLabel(frame)) === "Fullscreen", "minimized");
    await page.eval(`document.documentElement.dataset.theme = "light"`);
  });

  await scenario("no request leaves SilverBullet's origin, apart from the Trip Planner's map tiles", async () => {
    const outside = page.requests.filter((u) => /^https?:/.test(u) && !u.startsWith(SB) && !u.startsWith("https://tiles.openfreemap.org/"));
    assert.deepEqual([...new Set(outside)], []);
    assert.ok(page.requests.some((u) => u.includes("/.fs/Library/tlo/tlo-embed.js")), "library came from the space");
  });

  await scenario("SilverBullet's service worker survives the editors", async () => {
    const count = await page.eval(`navigator.serviceWorker.getRegistrations().then((r) => r.length)`);
    assert.ok(count >= 1, `registrations: ${count}`);
  });

  const errors = page.logs.filter((l) => /tlo/i.test(l));
  if (errors.length) console.log("console errors:\n" + errors.slice(0, 8).join("\n"));
}

const finish = (code) => { for (const c of children) c.kill?.() ?? c.close(); rmSync(space, { recursive: true, force: true }); process.exit(code); };
process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
main().then(() => { const failed = results.filter((r) => !r).length; console.log(`${results.length - failed}/${results.length} scenarios passed`); finish(failed ? 1 : 0); })
  .catch((e) => { console.error(e); finish(1); });
