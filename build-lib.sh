#!/usr/bin/env bash
# Build Tiny Little Office's editors from source into dist/lib. Needs git, node >= 24 and network access.
# Install scripts stay off: nothing here needs them.
# The output is one flat folder: SilverBullet's GitHub readers take a single path segment, so files in subfolders cannot install.
# To update upstream: put a new commit in UPSTREAM and run this again.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
checkout="$here/upstream"
commit="$(cat "$here/UPSTREAM")"
lib="$here/dist/lib"

if [ ! -d "$checkout/.git" ]; then
  git init -q "$checkout"
  git -C "$checkout" remote add origin https://github.com/aboard-io/tinylittleoffice.git
fi
if [ "$(git -C "$checkout" rev-parse -q --verify HEAD || true)" != "$commit" ]; then
  git -C "$checkout" fetch -q --depth 1 origin "$commit"
  git -C "$checkout" checkout -q --detach FETCH_HEAD
  rm -rf "$checkout/node_modules"
fi
[ -d "$checkout/node_modules" ] || (cd "$checkout" && npm ci --ignore-scripts --no-audit --no-fund --silent)

rm -rf "$checkout/embed"
cp -r "$here/lib" "$checkout/embed"
mkdir -p "$checkout/embed/public"
cp -r "$checkout/public/fonts" "$checkout/embed/public/fonts"
(cd "$checkout" && ./node_modules/.bin/vite build -c embed/vite.config.ts --logLevel warn)

rm -rf "$lib"
mkdir -p "$here/dist"
mv "$checkout/dist-embed" "$lib"
mv "$lib/fonts/LICENSE.txt" "$lib/FONTS-LICENSE.txt"
mv "$lib"/fonts/* "$lib/"
rmdir "$lib/fonts"
sed -i 's#url(\([^)]*\)fonts/#url(\1#g' "$lib/tlo-embed.css"
cp "$checkout/LICENSE" "$lib/TLO-LICENSE.txt"
# A file in a subfolder would fail to install.
[ -z "$(find "$lib" -mindepth 2 -print -quit)" ] || { echo "dist/lib is not flat:" >&2; find "$lib" -mindepth 2 >&2; exit 1; }
du -sh "$lib"
