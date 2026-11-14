#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ "${EUID}" == 0 ]]; then
  echo 'Run this as your regular Ubuntu user, without sudo. Playwright may separately request sudo for system packages.' >&2
  exit 1
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'Install Node.js 22 or 24 with npm first: https://nodejs.org/en/download' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'Node.js 22+ is required. Use Node.js 24 LTS or 22 LTS.' >&2
  exit 1
fi
npm ci
npx playwright install --with-deps chromium
npm run build
echo 'Setup complete. With MobaXterm X11 forwarding enabled, run: npm run login'
