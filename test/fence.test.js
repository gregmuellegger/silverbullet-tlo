import assert from "node:assert/strict";
import { test } from "node:test";
import { changeBetween, findFences, findLinkLines, isLink, linkReplacements, locateFence, renderFence } from "../src/fence.js";

const HOSTS = ["https://tinylittleoffice.com/"];

test("findFences returns body and exact offsets of a tlo fence", () => {
  const text = "intro\n```tlo\n---\napp: sheet\n---\na | b\n```\nafter";
  const [fence] = findFences(text);
  assert.equal(fence.body, "---\napp: sheet\n---\na | b");
  assert.equal(text.slice(fence.from, fence.to), "```tlo\n---\napp: sheet\n---\na | b\n```");
});

test("findFences ignores fences of other languages", () => {
  assert.deepEqual(findFences("```lua\nx\n```\n"), []);
});

test("a nested three-backtick fence does not end a four-backtick tlo fence", () => {
  const body = "# Report\n\n```sheet\na | b\n```\n\nEnd";
  const [fence] = findFences(renderFence(body));
  assert.equal(fence.body, body);
});

test("a tlo marker inside another code block is not treated as a fence", () => {
  assert.deepEqual(findFences("````md\n```tlo\nx\n```\n````\n"), []);
});

test("an indented fence is dedented on read and reindented on render", () => {
  const text = "- item\n  ```tlo\n  hello\n    deep\n  ```\n";
  const [fence] = findFences(text);
  assert.equal(fence.body, "hello\n  deep");
  assert.equal(renderFence(fence.body, "tlo", fence.indent), "  ```tlo\n  hello\n    deep\n  ```");
});

test("an empty fence has an empty body", () => {
  assert.equal(findFences("```tlo\n```\n")[0].body, "");
});

test("an unclosed fence is not returned, so nothing is written past the end of a document", () => {
  assert.deepEqual(findFences("```tlo\nnever closed\n"), []);
});

test("renderFence keeps blank lines free of indentation", () => {
  assert.equal(renderFence("a\n\nb", "tlo", "  "), "  ```tlo\n  a\n\n  b\n  ```");
});

test("locateFence finds the single match when no position is known", () => {
  const text = "```tlo\none\n```\n\n```tlo\ntwo\n```\n";
  assert.equal(text.slice(locateFence(text, "two").fence.from).startsWith("```tlo\ntwo"), true);
});

test("locateFence reports not-found when the body changed underneath the widget", () => {
  assert.equal(locateFence("```tlo\nnew\n```\n", "old").error, "not-found");
});

test("locateFence refuses identical fences without a position", () => {
  const text = "```tlo\nsame\n```\n\n```tlo\nsame\n```\n";
  assert.equal(locateFence(text, "same").error, "ambiguous");
});

test("locateFence picks the identical fence at the widget's position", () => {
  const text = "```tlo\nsame\n```\n\n```tlo\nsame\n```\n";
  const second = text.lastIndexOf("```tlo");
  assert.equal(locateFence(text, "same", second).fence.from, second);
  assert.equal(locateFence(text, "same", 0).fence.from, 0);
});

test("isLink tells a link body from .tlo text", () => {
  assert.equal(isLink("https://tinylittleoffice.com/sheet/#/v1/sheet/abc\n"), true);
  assert.equal(isLink("---\napp: sheet\n---\nsee https://example.com"), false);
});

test("findLinkLines finds bare and Markdown links in both link forms", () => {
  const packed = "https://tinylittleoffice.com/sheet/#/v1/sheet/abc";
  const plain = "https://tinylittleoffice.com/write/#title=x&doc=hello";
  const found = findLinkLines(`${packed}\n[Budget](${plain})\n`, HOSTS);
  assert.deepEqual(found.map((f) => f.link), [packed, plain]);
});

test("findLinkLines skips other hosts, links within prose, and links inside fences", () => {
  const link = "https://tinylittleoffice.com/sheet/#/v1/sheet/abc";
  const text = `https://example.com/#doc=x\nsee ${link} here\n\`\`\`tlo\n${link}\n\`\`\`\n`;
  assert.deepEqual(findLinkLines(text, HOSTS), []);
});

test("findLinkLines ignores a site link with no document in it", () => {
  assert.deepEqual(findLinkLines("https://tinylittleoffice.com/sheet/\n", HOSTS), []);
});

test("linkReplacements applied in order leaves every link fenced", () => {
  const a = "https://tinylittleoffice.com/sheet/#/v1/sheet/a";
  const b = "https://tinylittleoffice.com/write/#/v1/write/b";
  let text = `${a}\n\ntext\n\n${b}\n`;
  for (const r of linkReplacements(text, HOSTS)) text = text.slice(0, r.from) + r.insert + text.slice(r.to);
  assert.deepEqual(findFences(text).map((f) => f.body), [a, b]);
  assert.match(text, /\ntext\n/);
});

test("changeBetween replaces only what differs, at document offsets", () => {
  assert.deepEqual(changeBetween("```tlo\nHello\n```", "```tlo\nHello there\n```", 100), { from: 112, to: 112, insert: " there" });
  assert.deepEqual(changeBetween("abcXdef", "abcYdef"), { from: 3, to: 4, insert: "Y" });
  assert.deepEqual(changeBetween("abcdef", "abef"), { from: 2, to: 4, insert: "" });
});

test("changeBetween returns null for equal text", () => {
  assert.equal(changeBetween("same", "same"), null);
});

test("changeBetween handles repeats, where prefix and suffix could overlap", () => {
  const apply = (a, c) => a.slice(0, c.from) + c.insert + a.slice(c.to);
  for (const [a, b] of [["aaa", "aaaa"], ["aaaa", "aa"], ["abab", "ab"], ["", "x"], ["x", ""]]) assert.equal(apply(a, changeBetween(a, b)), b);
});

test("changeBetween gives the right text around surrogate pairs", () => {
  const apply = (a, c) => a.slice(0, c.from) + c.insert + a.slice(c.to);
  for (const [a, b] of [["a😀b", "a😁b"], ["😀", "😁"], ["x😀", "x😀😀"], ["😀😁", "😁😁"]]) assert.equal(apply(a, changeBetween(a, b)), b);
});

test("locateFence refuses a single match that does not hold the widget's position", () => {
  const text = "```tlo\ntheirs\n```\n\nmid\n\n```tlo\nsame\n```\n";
  assert.equal(locateFence(text, "same", 3).error, "not-found");
  assert.equal(locateFence(text, "same", text.indexOf("mid")).error, "not-found");
});

test("locateFence accepts a position anywhere in the matched fence, ends included", () => {
  const text = "x\n```tlo\nsame\n```\ny\n";
  const { from, to } = findFences(text)[0];
  for (const pos of [from, from + 5, to]) assert.equal(locateFence(text, "same", pos).fence.from, from);
});

test("locateFence refuses identical fences when the position is in neither", () => {
  const text = "```tlo\nsame\n```\n\nmid\n\n```tlo\nsame\n```\n";
  assert.equal(locateFence(text, "same", text.indexOf("mid")).error, "not-found");
});

test("findFences keeps a body's indent in raw, as SilverBullet passes it to the widget", () => {
  const [fence] = findFences("- item\n  ```tlo\n  hello\n\n    deep\n  ```\n");
  assert.equal(fence.raw, "  hello\n\n    deep");
  assert.equal(fence.body, "hello\n\n  deep");
});

test("locateFence matches the body with its indent, the form SilverBullet passes", () => {
  const text = "- item\n  ```tlo\n  hello\n  ```\n";
  assert.equal(locateFence(text, "  hello").fence.indent, "  ");
});

test("a fence in a nested list is found, indented four spaces or more", () => {
  const [fence] = findFences("- a\n  - b\n    ```tlo\n    hello\n    ```\n");
  assert.equal(fence.body, "hello");
  assert.equal(fence.indent, "    ");
});
