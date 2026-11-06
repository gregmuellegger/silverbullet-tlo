// Saves one widget's edits into its fence. The widget evaluates this file in SilverBullet's realm, not its own: when
// CodeMirror removes the iframe, the iframe's timers die, but a timer started here still writes the last edits.
// Writing is synchronous, so two saves cannot overlap and the widget lookup cannot go stale before the document changes.
import { changeBetween, findFences, locateFence, renderFence } from "./fence.js";

/** How long after the last edit a document is written into its fence. */
export const SAVE_DELAY_MS = 800;

/**
 * The widget objects CodeMirror compares for this fence: the one holding the iframe and the one in the current
 * decorations. Both are SilverBullet internals, so a miss returns less, and the widget rebuilds instead of staying.
 */
export function liveWidgets(view, frame, fence, body) {
  const found = new Set();
  try {
    const tile = frame.cmTile?.widget;
    if (tile?.bodyText === body) found.add(tile);
    for (const set of view.state.facet(view.constructor.decorations)) {
      set.between?.(fence.from, fence.to, (_from, _to, { widget }) => {
        if (widget?.bodyText === body) found.add(widget);
      });
    }
  } catch (e) {
    console.warn("tlo plug: the widget will rebuild after this save", e);
  }
  return [...found];
}

/**
 * Run `flush` before SilverBullet saves the page right away, as it does first when leaving a page. A document change
 * after that save starts cancels its timer and leaves the navigation waiting forever, and popstate is too late: it
 * reaches SilverBullet's listener first. Returns the way to stop. Without this, edits still save after their pause.
 */
export function beforePageSave(client, flush) {
  const manager = client.contentManager;
  if (!manager?.save) return () => {};
  if (!manager.save.tloFlushes) {
    const save = manager.save;
    const flushes = new Set();
    manager.save = function (immediate) {
      if (immediate) for (const each of [...flushes]) each();
      return save.call(this, immediate);
    };
    manager.save.tloFlushes = flushes;
  }
  const { tloFlushes } = manager.save;
  tloFlushes.add(flush);
  return () => tloFlushes.delete(flush);
}

export function createSaver({ client, frame, pageName, body, onStatus }) {
  let baseline = null;
  let pending = null;
  let timer = null;
  let retried = false;
  let position;
  let detached = false;
  let wrote = false;
  const stopWatching = beforePageSave(client, () => flush());

  /** With no status line left to show it, a failure must still reach the person, and the text must stay recoverable. */
  const reportLost = (detail, text) => {
    console.warn(`tlo plug: a document on ${pageName} was not saved (${detail}). Its text:\n${text}`);
    client.ui?.flashNotification?.(`A document on ${pageName} was not saved. Its text is in the browser console.`, "error");
  };

  const tell = (kind, detail) => {
    if (onStatus) onStatus(kind, detail);
    else if (kind === "error") reportLost(detail, pending);
  };

  const widgetPosition = () => {
    try {
      if (frame.isConnected) position = client.editorView.posAtDOM(frame);
    } catch {
      // Keep the last position: it still tells identical fences apart.
    }
    return position;
  };

  const schedule = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };

  /** Move the height estimate to the new body. Only a nicety, so an internal that moved does not stop a save. */
  const adoptHeight = (oldBody, newBody, shared) => {
    try {
      const height = parseFloat(frame.style.height);
      if (height > 0) client.widgetCache.setCachedWidgetMeta(newBody, { height, block: true });
      if (shared) return;
      client.widgetCache.removeCachedWidgetMeta(oldBody);
      client.widgetCache.invalidatePrewarm(oldBody);
    } catch {
      // The estimate falls back to SilverBullet's default.
    }
  };

  function write() {
    const view = client.editorView;
    if (client.currentName() !== pageName) return { error: "other-page" };
    if (client.isReadOnlyMode?.()) return { error: "read-only" };
    const text = view.state.sliceDoc();
    const located = locateFence(text, body, widgetPosition());
    if (located.error) return located;
    const { fence } = located;
    const saved = pending;
    const rendered = renderFence(saved, "tlo", fence.indent);
    // What SilverBullet reads back as this fence's body, indent included.
    const newBody = rendered.split("\n").slice(1, -1).join("\n");
    const change = changeBetween(text.slice(fence.from, fence.to), rendered, fence.from);
    const oldBody = body;
    const shared = findFences(text).filter((f) => f.raw === oldBody).length > 1;
    const widgets = liveWidgets(view, frame, fence, oldBody);
    try {
      // The old widget now equals the new one, so CodeMirror keeps the iframe.
      for (const widget of widgets) widget.bodyText = newBody;
      if (change) view.dispatch({ changes: change });
    } catch (e) {
      for (const widget of widgets) widget.bodyText = oldBody;
      throw e;
    }
    body = newBody;
    baseline = saved;
    pending = null;
    wrote = true;
    adoptHeight(oldBody, newBody, shared);
    return {};
  }

  /** Write now, if anything waits. Safe from any event handler: during a CodeMirror update it retries right after. */
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (pending === null) {
      if (detached) stopWatching();
      return;
    }
    let result;
    try {
      result = write();
    } catch (e) {
      if (!retried) {
        retried = true;
        schedule(0);
        return;
      }
      result = { error: "failed", message: e.message };
    }
    retried = false;
    if (detached) stopWatching();
    if (result.error) tell("error", result.message ?? result.error);
    else tell("saved");
  }

  /**
   * The page changed: a write that landed after SilverBullet's last save of that page went nowhere. That happens when
   * typing goes on during a page change, and the buffer it sat in is gone, so ask the disk.
   */
  async function confirmStored() {
    if (!wrote || client.currentName() === pageName) return;
    try {
      const { text } = await client.space.readPage(pageName);
      if (findFences(text).some((f) => f.raw === body)) return;
    } catch (e) {
      console.warn(`tlo plug: could not check ${pageName}`, e);
    }
    reportLost("written too late for the page's last save", body);
  }

  return {
    get body() {
      return body;
    },
    /** The body without its indent, which is what an editor opens. */
    documentBody() {
      const { fence } = locateFence(client.editorView.state.sliceDoc(), body, widgetPosition());
      return fence?.body ?? body;
    },
    get dirty() {
      return pending !== null;
    },
    /** The body as it stands in the fence, in the form the editor writes it. Opening a document writes nothing. */
    open(text) {
      baseline = text;
      widgetPosition();
    },
    /** The document changed: write `next` after a pause, or forget it if it is what the fence already holds. */
    edit(next) {
      pending = next === baseline ? null : next;
      // A removed iframe has no position to ask for, and this is the latest one it will have.
      widgetPosition();
      if (pending === null) {
        clearTimeout(timer);
        timer = null;
        tell("saved");
      } else {
        schedule(SAVE_DELAY_MS);
        tell("dirty");
      }
    },
    flush,
    /** The iframe is going away, possibly in the middle of a CodeMirror update: write once that update has finished. */
    detach() {
      onStatus = null;
      detached = true;
      if (pending === null) stopWatching();
      else schedule(0);
      void confirmStored();
    },
  };
}
