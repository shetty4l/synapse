#!/usr/bin/env bash
set -euo pipefail

# Synapse installer
# Usage: curl -fsSL https://github.com/shetty4l/synapse/releases/latest/download/install.sh | bash

SERVICE_NAME="synapse"
REPO="shetty4l/synapse"
INSTALL_BASE="${HOME}/srv/synapse"
DATA_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/synapse"

# --- source shared install functions from @shetty4l/core ---

INSTALL_LIB_URL="https://raw.githubusercontent.com/shetty4l/core/main/scripts/install-lib.sh"

install_lib=$(mktemp)
if ! curl -fsSL -o "$install_lib" "$INSTALL_LIB_URL"; then
  printf '\033[1;31m==>\033[0m %s\n' "Failed to download install-lib.sh from ${INSTALL_LIB_URL}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$install_lib"
rm -f "$install_lib"

# --- Synapse-specific: data directory + default config ---

setup_data_dir() {
  mkdir -p "$DATA_DIR"

  local config_file="${DATA_DIR}/config.json"
  if [ ! -f "$config_file" ]; then
    cat > "$config_file" <<'CONFIG'
{
  "port": 7750,
  "providers": [
    {
      "name": "ollama",
      "baseUrl": "http://localhost:11434/v1",
      "models": ["*"],
      "maxFailures": 3,
      "cooldownSeconds": 60
    }
  ]
}
CONFIG
    ok "Default config written to ${config_file}"
  else
    ok "Existing config preserved: ${config_file}"
  fi
}

# --- Synapse-specific: status ---

print_status() {
  echo ""
  echo "=========================================="
  ok "Synapse installed successfully!"
  echo "=========================================="
  echo ""
  echo "  Version:    ${RELEASE_TAG}"
  echo "  Install:    ${INSTALL_BASE}/latest"
  echo "  CLI:        ${BIN_DIR}/synapse"
  echo "  Config:     ${DATA_DIR}/config.json"
  echo ""
  echo "  Start the server:"
  echo "    synapse start"
  echo ""
  echo "  Check provider health:"
  echo "    synapse health"
  echo ""
  echo "  Edit ${DATA_DIR}/config.json to add providers."
  echo ""
}

# --- main ---

main() {
  info "Synapse installer"
  echo ""

  check_prereqs
  fetch_latest_release
  download_and_extract
  update_symlink
  prune_versions
  setup_data_dir
  install_cli
  print_status
}

main "$@"
