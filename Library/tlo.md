---
name: Library/tlo/tlo
tags: meta/library
@META@
---
# Tiny Little Office

Renders ` ```tlo ` fences as live [Tiny Little Office](https://tinylittleoffice.com) documents. The fence holds the document's `.tlo` text, and edits made in the document are written back into the fence.

## Use
* Type `/tlo` and pick an app, or run `TLO: Insert Document`.
* Paste a TLO link on its own line. It becomes a fence that keeps storing a link. Press **Convert to text** in the widget to store `.tlo` text instead.
* `TLO: Embed Links on This Page` converts links that are already on the page.

Edits are saved into the fence shortly after you stop typing, while you keep working in the document. Clicking outside it, Ctrl/Cmd+S and **Save** write at once.

**Fullscreen** enlarges the document over the page. **Minimize** or Escape returns it to its place.

The editors run in your browser from the files next to this page. No other server is involved.

## Config
```lua
config.set("tlo.embedPastedLinks", false)  -- keep pasted links as plain links
```
