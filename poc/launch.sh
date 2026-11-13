#!/bin/sh
# Launch an isolated VS Code (own user-data + extensions dir) with the probe installed and the browser proposal enabled.
# usage: launch.sh [folder ...]   (each folder opens in its own window)
rm -f "${TMPDIR:-/tmp}"/vsc-probe-*.json
(cd "$(dirname "$0")/probe-extension" && echo y | npx -y @vscode/vsce package --allow-missing-repository --skip-license -o /tmp/vsc-probe.vsix >/dev/null) && code --user-data-dir /tmp/vsc-probe-ud --extensions-dir /tmp/vsc-probe-ext --install-extension /tmp/vsc-probe.vsix --force
for f in "${@:-/tmp/vsc-probe-ws}"; do mkdir -p "$f"
  code --user-data-dir /tmp/vsc-probe-ud --extensions-dir /tmp/vsc-probe-ext --enable-proposed-api=local.vsc-probe --new-window "$f"; sleep 4; done
sleep 4; ls "${TMPDIR:-/tmp}"/vsc-probe-*.json
