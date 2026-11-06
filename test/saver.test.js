import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { SAVE_DELAY_MS, beforePageSave, createSaver, liveWidgets } from "../src/saver.js";

/** A stand-in for SilverBullet's client: one document, and a widget object as CodeMirror would hold it. */
function fakeClient(text, { page = "Page" } = {}) {
  const dispatched = [];
  const disk = { text };
  const view = {
    dispatched,
    state: {
      sliceDoc: () => text,
      facet: (facet) => view.constructor.decorations === facet ? view.sets : [],
    },
    sets: [],
    posAtDOM: () => text.indexOf("```tlo"),
    dispatch({ changes: { from, to, insert } }) {
      if (view.busy) throw new RangeError("Calls to EditorView.update are not allowed while an update is in progress");
      text = text.slice(0, from) + insert + text.slice(to);
      dispatched.push({ from, to, insert });
    },
  };
  view.constructor = { decorations: Symbol("decorations") };
  const client = {
    view,
    editorView: view,
    text: () => text,
    setText: (next) => { text = next; },
    currentName: () => page,
    isReadOnlyMode: () => false,
    notes: [],
    ui: { flashNotification(message, type) { client.notes.push({ message, type }); } },
    space: { readPage: async () => ({ text: disk.text }) },
    disk,
    goTo: (next) => { page = next; },
    widgetCache: {
      cached: new Map(),
      setCachedWidgetMeta(key, meta) { this.cached.set(key, meta); },
      removeCachedWidgetMeta(key) { this.cached.delete(key); },
      invalidatePrewarm() {},
    },
  };
  return client;
}

const widgetSet = (widget) => ({ between: (_from, _to, each) => each(0, 0, { widget }) });
const DOC = "before\n\n```tlo\nold\n```\n\nafter\n";

function setup({ text = DOC, body = "old", frame } = {}) {
  const client = fakeClient(text);
  const statuses = [];
  const held = { bodyText: body };
  const stateWidget = { bodyText: body };
  client.view.sets = [widgetSet(stateWidget)];
  const iframe = frame ?? { isConnected: true, cmTile: { widget: held }, style: { height: "522px" } };
  const saver = createSaver({ client, frame: iframe, pageName: "Page", body, onStatus: (kind, detail) => statuses.push(detail ? `${kind}:${detail}` : kind) });
  saver.open(body);
  return { client, saver, statuses, held, stateWidget, iframe };
}

beforeEach(() => mock.timers.reset());
const useTimers = () => mock.timers.enable({ apis: ["setTimeout"] });

test("an edit is written once, a pause after the last change, and the last text wins", () => {
  useTimers();
  const { client, saver, statuses } = setup();
  saver.edit("a");
  mock.timers.tick(SAVE_DELAY_MS - 1);
  saver.edit("ab");
  mock.timers.tick(SAVE_DELAY_MS - 1);
  assert.equal(client.view.dispatched.length, 0);
  assert.equal(statuses.at(-1), "dirty");
  mock.timers.tick(1);
  assert.equal(client.text(), "before\n\n```tlo\nab\n```\n\nafter\n");
  assert.equal(client.view.dispatched.length, 1);
  assert.equal(statuses.at(-1), "saved");
  assert.equal(saver.dirty, false);
});

test("the write replaces only the changed part of the body, leaving the fence's first line alone", () => {
  const { client, saver } = setup();
  saver.edit("older");
  saver.flush();
  const { from } = client.view.dispatched[0];
  assert.ok(from > DOC.indexOf("old"), `change starts at ${from}`);
});

test("both widget objects take the new body before the document changes", () => {
  const { client, saver, held, stateWidget } = setup();
  const seen = [];
  const dispatch = client.view.dispatch;
  client.view.dispatch = (spec) => { seen.push([held.bodyText, stateWidget.bodyText]); dispatch(spec); };
  saver.edit("new");
  saver.flush();
  assert.deepEqual(seen, [["new", "new"]]);
});

test("successive saves locate the fence by the body written last", () => {
  const { client, saver } = setup();
  for (const text of ["one", "two", "three"]) {
    saver.edit(text);
    saver.flush();
  }
  assert.equal(saver.body, "three");
  assert.equal(client.text(), "before\n\n```tlo\nthree\n```\n\nafter\n");
});

test("returning to the stored text cancels the waiting write", () => {
  useTimers();
  const { client, saver, statuses } = setup();
  saver.edit("x");
  saver.edit("old");
  mock.timers.tick(SAVE_DELAY_MS * 2);
  assert.equal(client.view.dispatched.length, 0);
  assert.equal(statuses.at(-1), "saved");
  assert.equal(saver.dirty, false);
});

test("after a save, the saved text is the new baseline", () => {
  const { client, saver } = setup();
  saver.edit("x");
  saver.flush();
  saver.edit("old");
  assert.equal(saver.dirty, true, "going back to the older text is a new edit");
  saver.flush();
  assert.equal(client.text(), DOC);
});

test("a fence changed underneath is left alone, and the edit stays pending", () => {
  const { client, saver, statuses, held } = setup();
  client.setText(DOC.replace("old", "theirs"));
  saver.edit("mine");
  saver.flush();
  assert.equal(client.text(), DOC.replace("old", "theirs"));
  assert.equal(statuses.at(-1), "error:not-found");
  assert.equal(saver.dirty, true);
  assert.equal(held.bodyText, "old", "no widget touched on a failed lookup");
});

test("another page in the editor is never written to", () => {
  const { client, saver, statuses } = setup();
  client.goTo("Other");
  saver.edit("mine");
  saver.flush();
  assert.equal(client.view.dispatched.length, 0);
  assert.equal(statuses.at(-1), "error:other-page");
});

test("identical fences resolve to the one at the widget's position", () => {
  const text = "```tlo\nsame\n```\n\nmid\n\n```tlo\nsame\n```\n";
  const { client, saver } = setup({ text, body: "same" });
  client.view.posAtDOM = () => text.lastIndexOf("```tlo");
  saver.edit("edited");
  saver.flush();
  assert.equal(client.text(), "```tlo\nsame\n```\n\nmid\n\n```tlo\nedited\n```\n");
});

test("with no widget object to be found, the save still happens", () => {
  const { client, saver, statuses, iframe } = setup();
  iframe.cmTile = undefined;
  client.view.sets = [];
  saver.edit("new");
  saver.flush();
  assert.equal(client.text(), DOC.replace("old", "new"));
  assert.equal(statuses.at(-1), "saved");
});

test("internals that throw during the lookup do not stop the save", (t) => {
  t.mock.method(console, "warn", () => {});
  const { client, saver } = setup();
  client.view.state.facet = () => { throw new Error("moved"); };
  saver.edit("new");
  saver.flush();
  assert.equal(client.text(), DOC.replace("old", "new"));
});

test("liveWidgets finds only the object for this body", () => {
  const client = fakeClient(DOC);
  const mine = { bodyText: "old" };
  client.view.sets = [widgetSet({ bodyText: "other" }), widgetSet(mine), { between: undefined }];
  assert.deepEqual(liveWidgets(client.view, {}, { from: 0, to: 10 }, "old"), [mine]);
});

test("a flush inside a CodeMirror update restores the widgets and retries right after", () => {
  useTimers();
  const { client, saver, statuses, held, stateWidget } = setup();
  client.view.busy = true;
  saver.edit("new");
  saver.flush();
  assert.equal(held.bodyText, "old");
  assert.equal(stateWidget.bodyText, "old");
  assert.equal(saver.dirty, true);
  client.view.busy = false;
  mock.timers.tick(0);
  assert.equal(client.text(), DOC.replace("old", "new"));
  assert.equal(statuses.at(-1), "saved");
});

test("a write that keeps failing reports it and keeps the edit", () => {
  useTimers();
  const { client, saver, statuses } = setup();
  client.view.busy = true;
  saver.edit("new");
  saver.flush();
  mock.timers.tick(0);
  assert.match(statuses.at(-1), /^error:Calls to EditorView/);
  assert.equal(saver.dirty, true);
});

test("a detached widget writes its waiting edit right after the current update, without calling back", () => {
  useTimers();
  const { client, saver, statuses, iframe } = setup();
  saver.edit("last words");
  const told = statuses.length;
  iframe.isConnected = false;
  saver.detach();
  assert.equal(client.view.dispatched.length, 0, "not inside the update that removed the iframe");
  mock.timers.tick(0);
  assert.equal(client.text(), DOC.replace("old", "last words"));
  assert.equal(statuses.length, told);
});

test("a detached widget whose fence changed does not write, and says where its text went", (t) => {
  useTimers();
  const warn = t.mock.method(console, "warn", () => {});
  const { client, saver, iframe } = setup();
  saver.edit("unsaved words");
  iframe.isConnected = false;
  client.setText(DOC.replace("old", "theirs"));
  saver.detach();
  mock.timers.tick(0);
  assert.equal(client.text(), DOC.replace("old", "theirs"));
  assert.equal(client.notes.length, 1);
  assert.equal(client.notes[0].type, "error");
  assert.match(client.notes[0].message, /Page/);
  assert.match(client.notes[0].message, /console/);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /unsaved words/);
});

test("a live widget shows failures in its own status, not as a notification", () => {
  const { client, saver, statuses } = setup();
  client.goTo("Other");
  saver.edit("mine");
  saver.flush();
  assert.equal(statuses.at(-1), "error:other-page");
  assert.deepEqual(client.notes, []);
});

test("a position read at the last edit finds the right twin after the document moved", () => {
  useTimers();
  const twins = "```tlo\nsame\n```\n\nmid\n\n```tlo\nsame\n```\n";
  const client = fakeClient(twins);
  const second = () => client.text().lastIndexOf("```tlo");
  client.view.posAtDOM = second;
  const frame = { isConnected: true, style: {} };
  const saver = createSaver({ client, frame, pageName: "Page", body: "same" });
  saver.open("same");
  // Far enough down that the position read at open() now falls inside the first fence.
  client.setText("x".repeat(twins.lastIndexOf("```tlo") - 4) + "\n" + twins);
  saver.edit("edited");
  frame.isConnected = false;
  client.view.posAtDOM = () => { throw new Error("detached"); };
  saver.detach();
  mock.timers.tick(0);
  assert.ok(client.text().endsWith("```tlo\nsame\n```\n\nmid\n\n```tlo\nedited\n```\n"), client.text());
});

test("an edit waiting for a fence that changed never lands on an identical twin", (t) => {
  useTimers();
  t.mock.method(console, "warn", () => {});
  const twins = "```tlo\nsame\n```\n\nmid\n\n```tlo\nsame\n```\n";
  const { client, saver, iframe } = setup({ text: twins, body: "same" });
  saver.edit("mine");
  iframe.isConnected = false;
  client.setText(twins.replace("same", "theirs"));
  saver.detach();
  mock.timers.tick(0);
  assert.equal(client.text(), twins.replace("same", "theirs"));
  assert.equal(client.notes.length, 1);
});

test("a live widget follows a fence that moved, so a change above it never refuses a save", () => {
  const { client, saver } = setup();
  client.setText("a long new paragraph above\n\n" + DOC);
  saver.edit("new");
  saver.flush();
  assert.equal(client.text(), "a long new paragraph above\n\n" + DOC.replace("old", "new"));
});

test("on a read-only page nothing is written and the status says so", () => {
  const { client, saver, statuses } = setup();
  client.isReadOnlyMode = () => true;
  saver.edit("new");
  saver.flush();
  assert.equal(client.view.dispatched.length, 0);
  assert.equal(statuses.at(-1), "error:read-only");
  assert.equal(saver.dirty, true);
});

test("a write the page never stored is reported after the page changed", async (t) => {
  useTimers();
  const warn = t.mock.method(console, "warn", () => {});
  const { client, saver, iframe } = setup();
  saver.edit("written too late");
  saver.flush();
  assert.ok(client.text().includes("written too late"));
  client.goTo("Other");
  iframe.isConnected = false;
  saver.detach();
  await new Promise(setImmediate);
  assert.equal(client.notes.length, 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /written too late/);
});

test("a write that did reach the disk is not reported when the page changes", async () => {
  useTimers();
  const { client, saver, iframe } = setup();
  saver.edit("stored");
  saver.flush();
  client.disk.text = client.text();
  client.goTo("Other");
  iframe.isConnected = false;
  saver.detach();
  await new Promise(setImmediate);
  assert.deepEqual(client.notes, []);
});

test("detaching on the same page does not read the disk", async () => {
  useTimers();
  const { client, saver, iframe } = setup();
  client.space.readPage = () => { throw new Error("no read expected"); };
  saver.edit("new");
  saver.flush();
  iframe.isConnected = false;
  saver.detach();
  await new Promise(setImmediate);
  assert.deepEqual(client.notes, []);
});

test("a save records the widget's normal height for the new body", () => {
  const { client, saver } = setup();
  saver.edit("new");
  saver.flush();
  assert.deepEqual(client.widgetCache.cached.get("new"), { height: 522, block: true });
});

test("a missing widget cache does not fail the save", () => {
  const { client, saver, statuses } = setup();
  client.widgetCache = undefined;
  saver.edit("new");
  saver.flush();
  assert.equal(statuses.at(-1), "saved");
});

test("an indented fence saves again and again, with bodies shaped as SilverBullet sends them", () => {
  const text = "- item\n  ```tlo\n  old\n  ```\n";
  const { client, saver, held, statuses } = setup({ text, body: "  old" });
  assert.equal(saver.documentBody(), "old", "the editor opens the dedented body");
  saver.open("old");
  saver.edit("one\n\ntwo");
  saver.flush();
  assert.equal(client.text(), "- item\n  ```tlo\n  one\n\n  two\n  ```\n");
  assert.equal(held.bodyText, "  one\n\n  two");
  saver.edit("three");
  saver.flush();
  assert.equal(client.text(), "- item\n  ```tlo\n  three\n  ```\n");
  assert.deepEqual(statuses.filter((s) => s.startsWith("error")), []);
});

test("documentBody falls back to the body as given when the fence cannot be found", () => {
  const { client, saver } = setup();
  client.setText("no fence here");
  assert.equal(saver.documentBody(), "old");
});

test("a save drops the height entry of the old text", () => {
  const { client, saver } = setup();
  client.widgetCache.cached.set("old", { height: 500, block: true });
  saver.edit("one");
  saver.flush();
  saver.edit("two");
  saver.flush();
  assert.deepEqual([...client.widgetCache.cached.keys()], ["two"]);
});

test("a save keeps the height entry an identical twin still uses", () => {
  const text = "```tlo\nsame\n```\n\nmid\n\n```tlo\nsame\n```\n";
  const { client, saver } = setup({ text, body: "same" });
  client.widgetCache.cached.set("same", { height: 500, block: true });
  saver.edit("edited");
  saver.flush();
  assert.ok(client.widgetCache.cached.has("same"));
});

test("beforePageSave flushes before an immediate save only, and can be stopped", () => {
  const order = [];
  const client = { contentManager: { save(immediate) { order.push(`save ${immediate}`); } } };
  const stop = beforePageSave(client, () => order.push("flush"));
  client.contentManager.save(false);
  client.contentManager.save(true);
  assert.deepEqual(order, ["save false", "flush", "save true"]);
  stop();
  order.length = 0;
  client.contentManager.save(true);
  assert.deepEqual(order, ["save true"]);
});

test("a waiting edit cannot cancel SilverBullet's immediate save, whose promise a page change waits on", async () => {
  useTimers();
  const client = fakeClient(DOC);
  // As SilverBullet's save: each call replaces the timer, so a replaced call's promise never settles.
  let timeout;
  client.contentManager = {
    save(immediate) {
      return new Promise((resolve) => {
        clearTimeout(timeout);
        timeout = setTimeout(resolve, immediate ? 0 : 1000);
      });
    },
  };
  const dispatch = client.view.dispatch;
  client.view.dispatch = (spec) => { dispatch(spec); void client.contentManager.save(); };
  const saver = createSaver({ client, frame: { isConnected: true, style: {} }, pageName: "Page", body: "old" });
  saver.open("old");
  saver.edit("waiting");
  let settled = false;
  client.contentManager.save(true).then(() => { settled = true; });
  mock.timers.tick(0);
  await new Promise(setImmediate);
  assert.equal(settled, true);
  assert.equal(client.text(), DOC.replace("old", "waiting"));
});

test("the save hook is installed once for many widgets", () => {
  const client = { contentManager: { save() {} } };
  const flushed = [];
  beforePageSave(client, () => flushed.push(1));
  const wrapped = client.contentManager.save;
  beforePageSave(client, () => flushed.push(2));
  assert.equal(client.contentManager.save, wrapped);
  client.contentManager.save(true);
  assert.deepEqual(flushed, [1, 2]);
});

test("without a content manager, widgets still work", () => {
  assert.doesNotThrow(() => beforePageSave({}, () => {})());
});
