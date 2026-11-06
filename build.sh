#!/usr/bin/env bash
# Assemble the installable library in dist/plug: the plug, its page and the editors from dist/lib (build-lib.sh).
# Usage: ./build.sh [space-folder...]    also installs it into <space-folder>/Library/tlo/, replacing what is there
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
lib="$here/dist/lib"
out="$here/dist/plug"
[ -d "$lib" ] || { echo "dist/lib is missing: run ./build-lib.sh first" >&2; exit 1; }

fence="$(sed 's/^export //' "$here/src/fence.js")"
saver="$(sed '/^import /d;s/^export //' "$here/src/saver.js")"

rm -rf "$out"
mkdir -p "$out"
{
  printf '%s\n' "$fence"
  printf 'const SAVER_SOURCE = %s;\n' "$(printf '%s\n%s' "$fence" "$saver" | jq -Rs .)"
  printf 'const WIDGET_SCRIPT = %s;\n' "$(jq -Rs . < "$here/src/widget.js")"
  printf 'const WIDGET_CSS = %s;\n' "$(jq -Rs . < "$here/src/widget.css")"
  printf 'const HOST_CSS = %s;\n' "$(jq -Rs . < "$here/src/host.css")"
  cat "$here/src/plug.js"
} > "$out/tlo.plug.js"
cp -r "$lib"/. "$out/"
cp "$here/LICENSE" "$out/LICENSE.txt"

# SilverBullet updates a library only when its page changes, so the page carries the version and a hash of the plug.
version="$(jq -r .version "$here/package.json")"
build="$(cat "$out"/*.* | sha256sum | cut -c1-12)"
files="$(cd "$out" && find . -type f -printf '%P\n' | LC_ALL=C sort | sed 's/^/- /')"
awk -v version="$version" -v build="$build" -v files="$files" '
  $0 == "@META@" { print "version: " version; print "build: " build; print "files:"; print files; next }
  { print }' "$here/Library/tlo.md" > "$out/tlo.md"

for space in "$@"; do
  target="$space/Library/tlo"
  rm -rf "$target"
  mkdir -p "$target"
  cp -r "$out"/. "$target/"
done
