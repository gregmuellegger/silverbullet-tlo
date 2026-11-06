# silverbullet-tlo

Live [Tiny Little Office](https://tinylittleoffice.com) documents inside [SilverBullet](https://silverbullet.md) pages. A ` ```tlo ` fence renders as a spreadsheet, document, deck, drawing or any other TLO app. Edits are saved back into the Markdown as you type.

````markdown
```tlo
---
app: sheet
---
Item | Cost:money
--- | ---
Rent | 1200
```
````

Everything runs in the browser from files in your space: no extra server, and your documents stay in your notes. One exception: the Trip Planner loads map tiles from OpenFreeMap.

## Install

1. Run `Library: Install` in SilverBullet.
2. Enter `github:<owner>/silverbullet-tlo@dist/tlo.md`.
3. Type `/tlo` on a page and pick an app.

The library adds about 7 MB to your space, in `Library/tlo/`. Manual install: unzip a [release](../../releases) into that folder.

## Use

- **Save:** automatic, 800 ms after you stop typing. Clicking outside, Ctrl/Cmd+S and **Save** write at once.
- **Fullscreen:** enlarges a document over the page. **Minimize** or Escape returns it.
- **TLO links:** a link pasted on its own line becomes a fence. `TLO: Embed Links on This Page` converts existing ones. Turn this off with `config.set("tlo.embedPastedLinks", false)`.

## Know before you use it

- Tested with SilverBullet 2.12.1 in headless Chrome only. Firefox and Safari are unverified.
- Saving without refreshing the widget relies on SilverBullet internals. On another version edits still save, but the widget reloads and loses the caret.
- A widget can stay blank on a cold start in a fresh browser. Reloading should clear it.
- TLO's title box, Share, Download, Find and menu are not in the widget.

The full list is in [How it works](docs/how-it-works.md#limits).

## Develop

Needs Node 24, git, jq, curl and unzip.

```sh
npm test                 # fence logic and saving
npm run build            # editors from upstream source, then dist/plug
test/fetch-tools.sh      # SilverBullet and headless Chrome into .tools/ (Linux x86_64)
npm run test:e2e         # installs dist/plug into a throwaway space and drives real Chrome
./build.sh ~/my-space    # installs dist/plug into a space
./dev.sh                 # serves .dev/space on http://127.0.0.1:3000 and rebuilds on every change
```

`./dev.sh` needs `dist/lib` and `.tools/`, not Node. It seeds a page per app, and open tabs reload about 2 seconds after you save a file in `src/`. Set `TLO_DEV_PORT` to change the port, and delete `.dev` to start over.

`UPSTREAM` pins the TLO commit. To release, bump `version` in `package.json`, then push a tag such as `v0.1.0`: the release workflow tests the code, updates the `dist` branch that installs read from, and creates the GitHub release.

## License

MIT, see [LICENSE](LICENSE). Not affiliated with Tiny Little Office. The built library bundles TLO (MIT), IBM Plex fonts (OFL 1.1) and TLO's dependencies. Their licenses ship next to it as `TLO-LICENSE.txt`, `FONTS-LICENSE.txt` and `THIRD-PARTY-LICENSES.txt`.
