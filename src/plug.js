// Worker side of the plug. build.sh prepends fence.js and defines SAVER_SOURCE, WIDGET_SCRIPT, WIDGET_CSS and HOST_CSS.
const APPS = ["write", "outline", "deck", "sheet", "calc", "draw", "diagram", "anim", "cal", "trip"];
const PUBLIC_SITES = ["https://tinylittleoffice.com/", "https://aboard-io.github.io/tinylittleoffice/"];
// Space files the widget loads, relative to the space root. build.sh puts them there.
const LIB = ".fs/Library/tlo/";

const pendingSyscalls = new Map();
let lastSyscall = 0;

function syscall(name, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++lastSyscall;
    pendingSyscalls.set(id, { resolve, reject });
    self.postMessage({ type: "sys", id, name, args });
  });
}

const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

async function renderTlo(body, pageName) {
  return {
    html: `<style>${WIDGET_CSS}</style>
<div id="tlo-root">
  <div id="tlo-bar">
    <span id="tlo-status">Loading…</span>
    <span class="tlo-spacer"></span>
    <button id="tlo-convert" hidden title="Store the document as .tlo text instead of a link">Convert to text</button>
    <a id="tlo-open" target="_blank" rel="noreferrer noopener" title="Open a copy on tinylittleoffice.com">Open ↗</a>
    <button id="tlo-save">Save</button>
    <button id="tlo-full" title="Enlarge this document, or return it to its place">Fullscreen</button>
  </div>
  <div id="tlo-doc"></div>
</div>`,
    script: `(() => {const TLO_CONFIG = ${json({ body, pageName, lib: LIB })};
const SAVER_SOURCE = ${json(SAVER_SOURCE)};
const HOST_CSS = ${json(HOST_CSS)};
${WIDGET_SCRIPT}
})();`,
  };
}

async function insertDocument() {
  const options = APPS.map((name) => ({ name }));
  const choice = await syscall("editor.filterBox", "Document type", options, "", "Tiny Little Office app");
  if (!choice) return;
  await syscall("editor.insertAtCursor", `${renderFence(`---\napp: ${choice.name}\n---\n`)}\n`);
}

async function embedLinks() {
  const replacements = linkReplacements(await syscall("editor.getText"), PUBLIC_SITES);
  for (const { from, to, insert } of replacements) await syscall("editor.replaceRange", from, to, insert);
  return replacements.length;
}

async function embedLinksCommand() {
  const count = await embedLinks();
  await syscall("editor.flashNotification", count ? `Embedded ${count} TLO link(s)` : "No TLO links on their own line");
}

// Fires on every keystroke, so read the page only when a change could have inserted a link.
async function onPageModified({ changes }) {
  if (!changes.some(({ inserted }) => inserted.includes("#/v1/") || inserted.includes("doc="))) return;
  if (await syscall("config.get", "tlo.embedPastedLinks", true)) await embedLinks();
}

const functionMapping = { renderTlo, insertDocument, embedLinksCommand, onPageModified };

const manifest = {
  name: "tlo",
  functions: {
    renderTlo: { codeWidget: "tlo" },
    insertDocument: {
      command: { name: "TLO: Insert Document" },
      slashCommand: { name: "tlo", description: "Insert a Tiny Little Office document" },
    },
    embedLinksCommand: { command: { name: "TLO: Embed Links on This Page" } },
    onPageModified: { events: ["editor:pageModified"] },
  },
};

self.addEventListener("message", async ({ data }) => {
  if (data.type === "sysr") {
    const call = pendingSyscalls.get(data.id);
    pendingSyscalls.delete(data.id);
    if (data.error) call.reject(new Error(data.error));
    else call.resolve(data.result);
  } else if (data.type === "inv") {
    try {
      self.postMessage({ type: "invr", id: data.id, result: await functionMapping[data.name](...(data.args ?? [])) });
    } catch (e) {
      console.error(`tlo plug: ${data.name} failed`, e);
      self.postMessage({ type: "invr", id: data.id, error: e.message });
    }
  }
});

self.postMessage({ type: "manifest", manifest });

export const plug = { manifest, functionMapping };
