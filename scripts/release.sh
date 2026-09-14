#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path('extension/manifest.json').read_text())['version'])
PY
)
python3 scripts/build_release.py
mkdir -p dist
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git bundle create "dist/ZoomCodexInterpreter-v${VERSION}.bundle" --all
else
  echo "Warning: not a git repository; skipping Git bundle." >&2
fi
(
  cd dist
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 *.zip *.bundle > SHA256SUMS 2>/dev/null || true
  else
    sha256sum *.zip *.bundle > SHA256SUMS 2>/dev/null || true
  fi
)
echo
echo "Release files in dist/:"
ls -lh dist
