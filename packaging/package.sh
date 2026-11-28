#!/usr/bin/env bash
# Builds release/Z3R0-FRECUENCY.zip: the built game plus double-click launchers for
# macOS (Apple Silicon and Intel), Windows and Linux. Usage: npm run package
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="Z3R0-FRECUENCY"
GO_VERSION="1.27.4"
CACHE="$ROOT/packaging/.cache"
OUT="$ROOT/release"
STAGE="$OUT/$NAME"

cd "$ROOT"

echo "==> Build del juego (tsc + vite)"
npm run build
npm run check:assets

echo "==> Toolchain de Go"
if command -v go >/dev/null 2>&1; then
  GO="go"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) GO_HOST="linux-amd64" ;;
    Linux-aarch64) GO_HOST="linux-arm64" ;;
    Darwin-arm64) GO_HOST="darwin-arm64" ;;
    Darwin-x86_64) GO_HOST="darwin-amd64" ;;
    *) echo "Instala Go (https://go.dev/dl/) y vuelve a ejecutar."; exit 1 ;;
  esac
  GO="$CACHE/go/bin/go"
  if [ ! -x "$GO" ]; then
    mkdir -p "$CACHE"
    echo "    Descargando Go $GO_VERSION ($GO_HOST) en packaging/.cache"
    curl -fsSL "https://go.dev/dl/go$GO_VERSION.$GO_HOST.tar.gz" | tar -xz -C "$CACHE"
  fi
fi

echo "==> Preparando $STAGE"
rm -rf "$STAGE" "$OUT/$NAME.zip"
mkdir -p "$STAGE/sistema"
cp -R dist "$STAGE/juego"

build() {
  local goos="$1" goarch="$2" out="$3"
  (cd packaging/launcher && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" GOCACHE="$CACHE/gocache" \
    "$GO" build -trimpath -ldflags "-s -w" -o "$out" .)
}
echo "==> Compilando lanzadores"
build windows amd64 "$STAGE/Jugar-Windows.exe"
build linux amd64 "$STAGE/Jugar-Linux"
build darwin arm64 "$STAGE/sistema/lanzador-mac-arm64"
build darwin amd64 "$STAGE/sistema/lanzador-mac-intel"

cat > "$STAGE/Jugar-Mac.command" <<'EOF'
#!/bin/bash
# Double-click launcher for macOS. Picks the right binary for Apple Silicon or Intel.
cd "$(dirname "$0")" || exit 1
# Files unzipped from a download are quarantined; clear it so the launcher can run.
xattr -dr com.apple.quarantine . 2>/dev/null
if [ "$(uname -m)" = "arm64" ]; then BIN="sistema/lanzador-mac-arm64"; else BIN="sistema/lanzador-mac-intel"; fi
chmod +x "$BIN"
exec "./$BIN"
EOF
chmod +x "$STAGE/Jugar-Mac.command" "$STAGE/Jugar-Linux" "$STAGE"/sistema/*
cp packaging/LEEME.txt "$STAGE/LEEME.txt"

echo "==> Comprimiendo"
(cd "$OUT" && zip -qr -X "$NAME.zip" "$NAME")
du -sh "$OUT/$NAME.zip"
echo "Listo: release/$NAME.zip"
