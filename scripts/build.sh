#!/bin/bash
# Build gamelike-plugin-manage: compile src/ → lib/ with local tsc.
# Dependencies (cordis/schemastery/loader) are linked from the
# installed @deepseek-ai/dsh tree; runtime dependency `yaml` comes from npm install — this machine has no source checkout
# (packages/ + vendor/), so we link the npm-installed packages instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── DSH 安装树探测：env → 已知全局安装路径 → npm root -g 推导 ──
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in /usr/local/lib/node_modules/@deepseek-ai/dsh; do
    if [ -d "$candidate/node_modules/@deepseek-ai/cordis" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ]; then
  GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  if [ -n "$GLOBAL_ROOT" ] && [ -d "$GLOBAL_ROOT/@deepseek-ai/dsh" ]; then CHECKOUT="$GLOBAL_ROOT/@deepseek-ai/dsh"; fi
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/node_modules/@deepseek-ai/cordis" ]; then
  echo "build: cannot locate the dsh install (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$ROOT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC — run: npm install" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/node_modules/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$ROOT/node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg @deepseek-ai/cordis @deepseek-ai/cordis
link_pkg cosmokit @deepseek-ai/cosmokit
link_pkg @deepseek-ai/schemastery @deepseek-ai/schemastery
link_pkg @deepseek-ai/cordis-plugin-loader @deepseek-ai/cordis-plugin-loader
link_pkg @deepseek-ai/dsh-home-paths @deepseek-ai/dsh-home-paths

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
