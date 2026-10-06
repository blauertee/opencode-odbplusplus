#!/usr/bin/env bash
# Regenerate testdata/jetson-orin-baseboard.tgz: clone Antmicro's open
# Jetson Orin baseboard (Apache-2.0, ~680 parts, 800 nets, 8 copper layers)
# and export it to ODB++ with KiCad 9's kicad-cli (run in Docker).
set -euo pipefail

REPO=https://github.com/antmicro/jetson-orin-baseboard
REF=${REF:-34f0e7f5fbca441191e20ed55d93cf8614e12bed}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet "$REPO" "$WORK/board"
git -C "$WORK/board" checkout --quiet "$REF"

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORK:/w" -w /w/board kicad/kicad:9.0 \
  kicad-cli pcb export odb --compression tgz -o /w/jetson-orin-baseboard.tgz jetson-orin-baseboard.kicad_pcb

cp "$WORK/jetson-orin-baseboard.tgz" "$ROOT/testdata/"
cp "$WORK/board/LICENSE" "$ROOT/testdata/jetson-orin-baseboard.LICENSE"
echo "wrote testdata/jetson-orin-baseboard.tgz"
