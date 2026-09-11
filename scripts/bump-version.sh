#!/usr/bin/env bash
# Bump expo.version (app.json) and version (package.json) in sync.
# Usage: ./scripts/bump-version.sh 1.2.0
# NOTE: with runtimeVersion policy "appVersion" (see docs/RELEASE.md), every
# version bump creates a NEW native runtime — old binaries stop receiving OTA.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <new-version>   (e.g. $0 1.2.0)" >&2
  exit 1
fi

NEW_VERSION="$1"
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: '$NEW_VERSION' is not valid semver (expected X.Y.Z)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NEW_VERSION VAI_ROOT="$ROOT"

node -e "
const fs = require('fs');
const path = require('path');
const root = process.env.VAI_ROOT;
const v = process.env.NEW_VERSION;
for (const f of ['app.json', 'package.json']) {
  if (!fs.existsSync(path.join(root, f))) { console.error('Missing ' + f); process.exit(1); }
}
const appPath = path.join(root, 'app.json');
const pkgPath = path.join(root, 'package.json');
const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
app.expo.version = v;
pkg.version = v;
fs.writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('Bumped app.json (expo.version) + package.json (version) to ' + v);
"

echo 'Next: git diff, then commit (CI enforces eas.json/app.json/package.json stay in sync).'
echo 'Remember: new version = new runtimeVersion (appVersion policy) = needs a fresh native build per profile; OTA from the old runtime will NOT apply.'
