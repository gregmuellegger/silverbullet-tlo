#!/usr/bin/env bash
# Download what test/e2e.mjs drives into .tools/: the pinned SilverBullet server and headless Chrome. Linux x86_64 only.
set -euo pipefail

silverbullet_version=2.12.1
chrome_version=156.0.8078.80

tools="$(cd "$(dirname "$0")/.." && pwd)/.tools"
mkdir -p "$tools"
cd "$tools"

curl -fsSL -o silverbullet.zip "https://github.com/silverbulletmd/silverbullet/releases/download/$silverbullet_version/silverbullet-server-linux-x86_64.zip"
unzip -qo silverbullet.zip
curl -fsSL -o chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/$chrome_version/linux64/chrome-headless-shell-linux64.zip"
unzip -qo chrome.zip
rm silverbullet.zip chrome.zip
./silverbullet version
