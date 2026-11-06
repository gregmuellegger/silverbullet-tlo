#!/usr/bin/env bash
# Serve a persistent dev space from .dev/space and keep its plug current: a change to src/, Library/ or dist/lib rebuilds it, and open tabs reload.
# Needs dist/lib (./build-lib.sh) and SilverBullet (test/fetch-tools.sh), or TLO_SILVERBULLET pointing at the binary. Only bash and jq at runtime, like build.sh.
# Usage: ./dev.sh    TLO_DEV_PORT picks the port, 3000 by default. Delete .dev to start over.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
silverbullet="${TLO_SILVERBULLET:-$here/.tools/silverbullet}"
port="${TLO_DEV_PORT:-3000}"
space="$here/.dev/space"
plug="$here/dist/plug"
target="$space/Library/tlo"

[ -x "$silverbullet" ] || { echo "SilverBullet is missing: run test/fetch-tools.sh" >&2; exit 1; }
[ -d "$here/dist/lib" ] || { echo "dist/lib is missing: run ./build-lib.sh" >&2; exit 1; }

# Pages you edited stay: seeding only fills in what is missing.
seed() {
  local file="$space/$1.md"
  [ -e "$file" ] && return
  mkdir -p "$(dirname "$file")"
  printf '%s' "$2" > "$file"
}

seed_space() {
  local app index=$'# TLO dev space\n\n'
  for app in $(sed -n 's/^const APPS = \[\(.*\)\];$/\1/p' "$here/src/plug.js" | tr -d '",'); do
    seed "App/$app" "$(printf '# %s\n\n```tlo\n---\napp: %s\n---\n```\n\nend\n' "$app" "$app")"$'\n'
    index+="* [[App/$app]]"$'\n'
  done
  seed index "$index"
  # tlo.md carries a hash of the whole build, so it changes exactly when a tab has something new to load.
  seed "Dev Reload" '```space-lua
local rebuilt = false

event.listen {
  name = "file:changed",
  run = function(e)
    if e.data[1] == "Library/tlo/tlo.md" then rebuilt = true end
  end
}

-- Waits for the next tick: reloading in the middle of a sync delays the widgets by 10 seconds.
event.listen {
  name = "cron:secondPassed",
  run = function()
    if rebuilt then editor.reloadUI() end
  end
}
```
'
}

# Moves the file in whole, so SilverBullet never reads half of it.
put() {
  cmp -s "$1" "$2" && return
  cp "$1" "$here/.dev/staged"
  mv "$here/.dev/staged" "$2"
}

# Unlike ./build.sh <space> this keeps unchanged files: clearing the folder would make tabs sync 7 MB of editors again.
install_plug() {
  local file
  mkdir -p "$target"
  for file in "$target"/*; do
    [ -e "$plug/${file##*/}" ] || rm -f "$file"
  done
  for file in "$plug"/*; do
    [ "${file##*/}" = tlo.md ] || put "$file" "$target/${file##*/}"
  done
  put "$plug/tlo.md" "$target/tlo.md" # Last: this one reloads tabs.
}

rebuild() {
  if "$here/build.sh"; then install_plug; echo "$(date +%T) plug rebuilt"; else echo "$(date +%T) build failed, still serving the last plug" >&2; fi
}

fingerprint() {
  find "$here/src" "$here/Library" "$here/dist/lib" -type f -printf '%p %T@ %s\n' 2>/dev/null | sort | sha256sum
}

mkdir -p "$space"
seed_space
seen="$(fingerprint)"
rebuild

"$silverbullet" --single -L 127.0.0.1 -p "$port" "$space" &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
echo "Dev space on http://127.0.0.1:$port, watching src/, Library/ and dist/lib. Ctrl+C stops it."

while kill -0 "$server" 2>/dev/null; do
  sleep 0.5
  now="$(fingerprint)"
  [ "$now" = "$seen" ] && continue
  seen="$now"
  rebuild
done
echo "SilverBullet stopped: is port $port in use?" >&2
exit 1
