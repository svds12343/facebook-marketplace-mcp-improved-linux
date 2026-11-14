#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

case "${1:-}" in
  ''|--login) ;;
  --help|-h)
    echo 'Usage: bash scripts/setup-ubuntu.sh [--login]'
    echo 'Install dependencies, including Node.js 24/npm via nvm when missing or too old.'
    echo '--login also opens Facebook login and checks the saved session in this shell.'
    exit 0
    ;;
  *) echo "Unknown argument: $1" >&2; exit 1 ;;
esac
if (( $# > 1 )); then
  echo 'Expected at most one argument: --login' >&2
  exit 1
fi

if [[ "${EUID}" == 0 ]]; then
  echo 'Run this as your regular Ubuntu user, without sudo. Playwright may separately request sudo for system packages.' >&2
  exit 1
fi

compatible_node() {
  command -v node >/dev/null && command -v npm >/dev/null &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}

if ! compatible_node; then
  echo 'Installing Node.js 24 and npm for your user via nvm...'
  if [[ -z "${NVM_DIR:-}" ]]; then
    if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
      export NVM_DIR="$XDG_CONFIG_HOME/nvm"
    else
      export NVM_DIR="$HOME/.nvm"
    fi
  fi
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    if ! command -v curl >/dev/null && ! command -v wget >/dev/null; then
      sudo apt-get update
      sudo apt-get install -y ca-certificates curl
    fi
    setup_installer="$(mktemp)"
    trap 'rm -f -- "$setup_installer"' EXIT
    # Pinned official nvm installer; execute only after the download succeeds.
    setup_nvm_url='https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh'
    if command -v curl >/dev/null; then
      curl --fail --show-error --silent --location --retry 3 --connect-timeout 20 \
        "$setup_nvm_url" -o "$setup_installer"
    else
      wget --quiet --timeout=30 --tries=3 "$setup_nvm_url" -O "$setup_installer"
    fi
    mkdir -p -- "$NVM_DIR"
    NVM_INSTALL_VERSION=v0.41.0 bash "$setup_installer"
    rm -f -- "$setup_installer"
    trap - EXIT
  fi
  # nvm is a shell function and does not support all strict shell settings.
  # Keep it in this shell and explicitly propagate failures while loading it.
  set +e +u
  set +o pipefail
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh" --no-use || exit $?
  nvm install 24 || exit $?
  nvm use 24 || exit $?
  set -euo pipefail
  if ! compatible_node; then
    echo 'Node.js/npm installation did not provide a working Node.js 22+ environment.' >&2
    exit 1
  fi
  echo 'For npm commands in another shell, reload your shell profile and run: nvm use 24'
fi
npm ci
npx playwright install --with-deps chromium
npm run build
if [[ "${1:-}" == --login ]]; then
  npm run login
  npm run auth:check
else
  echo 'Setup complete. To set up login in this environment, run: bash scripts/setup-ubuntu.sh --login'
fi
