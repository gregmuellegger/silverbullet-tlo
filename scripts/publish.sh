#!/usr/bin/env bash
# Called by the release workflow: publish a built library folder for the pushed tag.
# The dist branch is force-pushed as a single commit, so 7 MB of build output does not pile up in history.
# Usage: scripts/publish.sh <plug-folder>    needs GITHUB_REF_NAME, GITHUB_REPOSITORY and GH_TOKEN
set -euo pipefail

plug="$1"
tag="$GITHUB_REF_NAME"
version="$(jq -r .version package.json)"
[ "$tag" = "v$version" ] || { echo "tag $tag does not match package.json version $version" >&2; exit 1; }
grep -qx "version: $version" "$plug/tlo.md" || { echo "$plug/tlo.md is not version $version" >&2; exit 1; }

archive="$RUNNER_TEMP/silverbullet-tlo-$tag.zip"
(cd "$plug" && zip -qr "$archive" .)

git -C "$plug" init -q -b dist
git -C "$plug" add -A
git -C "$plug" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -q -m "Release $tag"
git -C "$plug" push -q --force "https://x-access-token:$GH_TOKEN@github.com/$GITHUB_REPOSITORY.git" dist

gh release create "$tag" "$archive" --verify-tag --generate-notes
