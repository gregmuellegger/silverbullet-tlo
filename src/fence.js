// Pure text logic shared by the plug worker and the widget. No browser or SilverBullet APIs here, so `node --test` covers it.

/** A line holding nothing but a Tiny Little Office link, bare or as a Markdown link. */
const LINK_LINE = /^[ \t]*(?:\[[^\]\n]*\]\()?(https?:\/\/[^\s)]+#(?:\/v1\/|[^\s)]*\b(?:doc|md)=)[^\s)]*)\)?[ \t]*$/;

/**
 * Every fence of `lang` in `text`, with offsets. `body` is dedented by the opening fence's indent. `raw` keeps the
 * indent, which is the form SilverBullet passes to a widget.
 */
export function findFences(text, lang = "tlo") {
  const fences = [];
  const lines = text.split("\n");
  let offset = 0;
  let open = null;
  for (const line of lines) {
    const end = offset + line.length;
    if (open) {
      const close = line.match(/^([ \t]*)(`{3,}|~{3,})[ \t]*$/);
      if (close && close[2][0] === open.marker[0] && close[2].length >= open.marker.length) {
        if (open.lang === lang) {
          const raw = open.body;
          const strip = (l) => (l.startsWith(open.indent) ? l.slice(open.indent.length) : l.trimStart());
          fences.push({ from: open.from, to: end, indent: open.indent, marker: open.marker, raw: raw.join("\n"), body: raw.map(strip).join("\n") });
        }
        open = null;
      } else {
        open.body.push(line);
      }
    } else {
      const start = line.match(/^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)/);
      if (start) open = { from: offset, indent: start[1], marker: start[2], lang: start[3], body: [] };
    }
    offset = end + 1;
  }
  return fences;
}

/** A fence around `body`, longer than any fence inside it, so a nested ```sheet cannot close it early. */
export function renderFence(body, lang = "tlo", indent = "") {
  const longest = Math.max(2, ...[...body.matchAll(/^[ \t]*(`{3,})/gm)].map((m) => m[1].length));
  const marker = "`".repeat(longest + 1 > 3 ? longest + 1 : 3);
  return [marker + lang, ...body.split("\n"), marker].map((line) => (line ? indent + line : line)).join("\n");
}

/**
 * The fence a widget showing `body` (with its indent) belongs to. A known `pos`, the widget's document position, must
 * fall inside the match: a match elsewhere is another fence that happens to hold the same text, and writing there
 * loses a document. Without a position, identical fences are ambiguous and nothing is chosen.
 */
export function locateFence(text, body, pos, lang = "tlo") {
  const matches = findFences(text, lang).filter((f) => f.raw === body);
  if (matches.length === 0) return { error: "not-found" };
  if (pos === undefined || pos === null) return matches.length === 1 ? { fence: matches[0] } : { error: "ambiguous" };
  const fence = matches.find((f) => pos >= f.from && pos <= f.to);
  return fence ? { fence } : { error: "not-found" };
}

/** Is this fence body a link rather than .tlo text? */
export function isLink(body) {
  return /^\s*https?:\/\/\S+\s*$/.test(body);
}

/** Lines of `text` that hold only a Tiny Little Office link on one of `hosts`, skipping any inside a fence. */
export function findLinkLines(text, hosts) {
  const fenced = findAllFenceRanges(text);
  const found = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = line.match(LINK_LINE);
    if (match && !fenced.some(([from, to]) => offset >= from && offset <= to) && hosts.some((h) => match[1].startsWith(h))) {
      found.push({ from: offset, to: offset + line.length, link: match[1] });
    }
    offset += line.length + 1;
  }
  return found;
}

function findAllFenceRanges(text) {
  const ranges = [];
  let offset = 0;
  let open = null;
  for (const line of text.split("\n")) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!open) open = { from: offset, marker: fence[1] };
      else if (fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length) {
        ranges.push([open.from, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  return ranges;
}

/** Fences for each link line, last first so earlier offsets stay valid while replacing. */
export function linkReplacements(text, hosts) {
  return findLinkLines(text, hosts)
    .reverse()
    .map(({ from, to, link }) => ({ from, to, insert: renderFence(link) }));
}

/** The smallest replacement turning `before` into `after`, with offsets moved by `offset`. Null when they are equal. */
export function changeBetween(before, after, offset = 0) {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before[start] === after[start]) start++;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: offset + start, to: offset + before.length - end, insert: after.slice(start, after.length - end) };
}
