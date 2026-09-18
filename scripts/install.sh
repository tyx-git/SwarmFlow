#!/bin/sh
set -eu

REPO="${SWARMFLOW_REPO:-tyx-git/SwarmFlow}"
INSTALL_DIR="${SWARMFLOW_INSTALL_DIR:-$HOME/.swarmflow/bin}"

os="$(uname -s)"
arch="$(uname -m)"

# Normalize arch labels to what we publish.
case "$arch" in
  arm64|aarch64) arch_label="arm64" ;;
  x86_64|amd64)  arch_label="x64" ;;
  *) echo "swarmflow: unsupported architecture: $arch" >&2; exit 1 ;;
esac

# Map OS + arch to the published tarball name.
asset=""
case "$os" in
  Darwin)
    if [ "$arch_label" != "arm64" ]; then
      echo "swarmflow: this script does not publish a macOS x64 build. Run on Apple Silicon, or build from source: https://www.github.com/tyx-git/SwarmFlow" >&2
      exit 1
    fi
    asset="swarmflow-darwin-arm64.tar.gz"
    ;;
  Linux)
    asset="swarmflow-linux-${arch_label}.tar.gz"
    ;;
  *)
    echo "swarmflow: unsupported OS: $os (this script supports Darwin and Linux; Windows users should run scripts/install.ps1 or download swarmflow-win32-{x64,arm64}.tar.gz directly from Releases)" >&2
    exit 1
    ;;
esac

if [ "${SWARMFLOW_VERSION:-}" ]; then
  url="https://www.github.com/tyx-git/SwarmFlow"
else
  url="https://www.github.com/tyx-git/SwarmFlow"
fi

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/$asset"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/$asset" "$url"
else
  echo "swarmflow: curl or wget is required" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/swarmflow" 2>/dev/null || true

# macOS only: strip Gatekeeper quarantine off the unsigned binary so
# it can launch without a manual right-click → Open dance.
if [ "$os" = "Darwin" ]; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR/swarmflow" 2>/dev/null || true
fi

path_line='export PATH="$HOME/.swarmflow/bin:$PATH"'
profile=""
if [ -n "${SHELL:-}" ]; then
  case "$(basename "$SHELL")" in
    zsh) profile="$HOME/.zshrc" ;;
    bash) profile="$HOME/.bashrc" ;;
  esac
fi
[ -n "$profile" ] || profile="$HOME/.profile"

needs_source=0
if [ "$INSTALL_DIR" = "$HOME/.swarmflow/bin" ] && ! printf '%s' ":$PATH:" | grep -q ":$HOME/.swarmflow/bin:"; then
  touch "$profile"
  if ! grep -Fq "$path_line" "$profile"; then
    printf '\n%s\n' "$path_line" >> "$profile"
  fi
  needs_source=1
fi

if version=$("$INSTALL_DIR/swarmflow" --version 2>/dev/null); then
  installed_label="Installed SwarmFlow $version"
else
  installed_label="Installed SwarmFlow"
fi

echo
echo "✓ $installed_label"
echo
echo "To get started:"
if [ "$needs_source" = "1" ]; then
  echo "  source $profile"
fi
echo "  swarmflow init"
