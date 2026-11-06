// Runs inside SilverBullet's widget iframe. TLO_CONFIG, SAVER_SOURCE and HOST_CSS are prepended by renderTlo.
// The editors come from the library in the space, so everything happens in this one document.
// Saving lives in saver.js. This file connects the editor, the bar and the events that should flush an edit.
const statusEl = document.getElementById("tlo-status");
const saveButton = document.getElementById("tlo-save");
const fullButton = document.getElementById("tlo-full");
const convertButton = document.getElementById("tlo-convert");
const openLink = document.getElementById("tlo-open");
const root = document.getElementById("tlo-root");

// A removed iframe loses `parent` and `frameElement`, and its cleanup still needs them.
const host = parent;
const frame = frameElement;
const hostRoot = host.document.documentElement;

// The iframe's own base is unreliable: it resolves against the page's folder. The parent's is the space root.
const libUrl = (path) => new URL(TLO_CONFIG.lib + path, host.document.baseURI).href;
// Listeners on the parent outlive this frame unless removed.
const alive = new AbortController();
const whileAlive = { signal: alive.signal };

const setStatus = (text, kind = "") => {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
};

const FAILURES = {
  "not-found": "Not saved: this block changed in the page. Reload to continue.",
  ambiguous: "Not saved: an identical block exists on this page.",
  "other-page": "Not saved: another page is open.",
  "read-only": "Not saved: this page is read-only.",
};

const onStatus = (kind, detail) => {
  if (kind === "saved") setStatus("Saved");
  else if (kind === "dirty") setStatus("Unsaved: saving shortly", "dirty");
  else setStatus(FAILURES[detail] ?? `Not saved: ${detail}`, "error");
};

// "Widgets: Refresh All" evaluates this script again in the same window, with the body the iframe was first built from.
const previous = globalThis.tloWidget;
previous?.dispose();

const createSaver = new host.Function(`${SAVER_SOURCE}\nreturn createSaver;`)();
const saver = createSaver({
  client: host.client,
  frame,
  pageName: TLO_CONFIG.pageName,
  body: previous?.body ?? TLO_CONFIG.body,
  onStatus,
});

// The page's copy button and the enlarged iframe are styled from the page, once for all widgets.
const hostStyle = host.document.getElementById("tlo-host-style") ??
  host.document.head.appendChild(Object.assign(host.document.createElement("style"), { id: "tlo-host-style" }));
if (hostStyle.textContent !== HOST_CSS) hostStyle.textContent = HOST_CSS;
frame.dataset.tlo = "";

// Follow SilverBullet's light or dark theme.
const followTheme = () => {
  document.documentElement.dataset.theme = hostRoot.dataset.theme === "dark" ? "dark" : "light";
};
followTheme();
const themeWatch = new MutationObserver(followTheme);
themeWatch.observe(hostRoot, { attributeFilter: ["data-theme"] });
alive.signal.addEventListener("abort", () => themeWatch.disconnect());

const report = () => host.postMessage({ type: "setHeight", height: document.documentElement.offsetHeight });
const sizeWatch = new ResizeObserver(report);
sizeWatch.observe(root);
alive.signal.addEventListener("abort", () => sizeWatch.disconnect());

// Set while enlarged: stopping it lets the page scroll again.
let enlarged = null;

// The iframe goes into the top layer, which sits above the whole page whatever its ancestors do, and moving an iframe
// in the DOM would reload it. Inside, the document stays the size it was and #tlo-root floats over it, so nothing that
// measures this document, SilverBullet's own height check included, ever sees the enlarged size.
function enlarge() {
  // The page holds one height for the enlarged document's line, so only one document can be enlarged.
  host.document.querySelector("iframe[data-tlo-full]")?.contentWindow.tloWidget?.minimize();
  const line = frame.closest(".cm-line") ?? frame.parentElement;
  const scroller = host.client.editorView.scrollDOM;
  const scrollTop = scroller.scrollTop;
  enlarged = new AbortController();
  // CodeMirror unmounts what scrolls out of view, and it measures inside its own scroll listener, so get there first.
  host.document.addEventListener("scroll", (event) => {
    if (event.target !== scroller) return;
    event.stopImmediatePropagation();
    scroller.scrollTop = scrollTop;
  }, { capture: true, signal: enlarged.signal });
  hostRoot.style.setProperty("--tlo-held-height", `${line.getBoundingClientRect().height}px`);
  document.documentElement.style.setProperty("--tlo-normal-height", `${document.documentElement.offsetHeight}px`);
  document.documentElement.dataset.tloFull = "";
  frame.dataset.tloFull = "";
  frame.popover = "manual";
  frame.showPopover?.();
  fullButton.textContent = "Minimize";
}

function minimize() {
  if (frame.isConnected) frame.hidePopover?.();
  frame.removeAttribute("popover");
  delete frame.dataset.tloFull;
  delete document.documentElement.dataset.tloFull;
  hostRoot.style.removeProperty("--tlo-held-height");
  enlarged.abort();
  enlarged = null;
  fullButton.textContent = "Fullscreen";
}

const openOverlay = () => document.querySelector("dialog[open], :popover-open:not(.to-context)");

// TLO's Escape steps out one level per press, and some editors take every press, such as the Sheet on a cell. So the
// first press an editor uses stays with it, and the next one minimizes. An open dialog or popover keeps them all.
let escapeUsed = false;
const minimizeOnEscape = (event) => {
  if (event.key !== "Escape") {
    escapeUsed = false;
    return;
  }
  if (!enlarged || event.isComposing || openOverlay()) return;
  if (event.defaultPrevented && !escapeUsed) {
    escapeUsed = true;
    return;
  }
  escapeUsed = false;
  minimize();
};
addEventListener("keydown", minimizeOnEscape, whileAlive);
// The focus is on the page after a click on the dimmed area, and SilverBullet has no claim on Escape while it is dimmed.
host.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && enlarged) minimize();
}, { ...whileAlive, capture: true });

function close() {
  saver.detach();
  if (enlarged) minimize();
  alive.abort();
}

globalThis.tloWidget = {
  get body() {
    return saver.body;
  },
  dispose() {
    saver.flush();
    close();
  },
  minimize,
};

async function start() {
  let lib;
  try {
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = libUrl("tlo-embed.css");
    document.head.prepend(sheet);
    lib = await import(libUrl("tlo-embed.js"));
  } catch (e) {
    console.error("tlo plug: library failed to load", e);
    setStatus(`The TLO library is missing from ${TLO_CONFIG.lib}. Install it again with Library: Install.`, "error");
    return;
  }

  let opened;
  try {
    opened = lib.openBody(saver.documentBody());
  } catch (e) {
    setStatus(`Cannot open this document: ${e.message}`, "error");
    return;
  }
  let current = opened.text;
  saver.open(lib.bodyOf(opened, current));
  openLink.href = lib.hostedLink(opened, current);
  convertButton.hidden = !opened.link;

  await lib.mount(document.getElementById("tlo-doc"), {
    app: opened.app,
    text: current,
    onChange(text) {
      current = text;
      saver.edit(lib.bodyOf(opened, text));
      openLink.href = lib.hostedLink(opened, text);
    },
  });
  setStatus("Saved");

  convertButton.addEventListener("click", () => {
    opened = { ...opened, link: undefined };
    saver.edit(lib.textBody(opened, current));
    saver.flush();
    convertButton.hidden = true;
  });
}

saveButton.addEventListener("click", () => saver.flush());
fullButton.addEventListener("click", () => (enlarged ? minimize() : enlarge()));
// Pressing a bar button must not take the caret out of the document.
document.getElementById("tlo-bar").addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault();
});

addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saver.flush();
  }
}, whileAlive);

addEventListener("blur", () => saver.flush(), whileAlive);
host.document.addEventListener("visibilitychange", () => {
  if (host.document.visibilityState === "hidden") saver.flush();
}, whileAlive);
// A closing tab cannot wait for SilverBullet to store a flushed edit. Its own warning has run or will see nothing yet,
// and its save waits a second. An edit that was still waiting is ours to ask about, even once it reached the page.
host.addEventListener("beforeunload", (event) => {
  const waiting = saver.dirty;
  saver.flush();
  if (waiting || saver.dirty) event.preventDefault();
}, whileAlive);

addEventListener("pagehide", close, whileAlive);

void start();
