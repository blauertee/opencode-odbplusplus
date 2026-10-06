#!/usr/bin/env bash
# Build native/lib/libodbpp.so (+ libOdbDesign, libUtils) for the plugin.
#
# Needs: git, cmake >= 3.21, ninja, a C++17 compiler and the development
# packages for protobuf, libarchive and zlib. On Debian/Ubuntu:
#   apt install git cmake ninja-build g++ libprotobuf-dev protobuf-compiler \
#               libarchive-dev zlib1g-dev libasio-dev
# Crow (header-only, needed by OdbDesignLib) is fetched automatically.
set -euo pipefail

ODBDESIGN_REF=${ODBDESIGN_REF:-d777042fa42a206ce0216ea016064d98640ed57f}
CROW_REF=${CROW_REF:-v1.2.1}
HERE=$(cd "$(dirname "$0")" && pwd)
VENDOR="$HERE/vendor"
mkdir -p "$VENDOR"

if [ ! -d "$VENDOR/Crow" ]; then
  git clone --quiet --depth 1 --branch "$CROW_REF" https://github.com/CrowCpp/Crow "$VENDOR/Crow"
fi
if [ ! -f "$VENDOR/crow-install/lib/cmake/Crow/CrowConfig.cmake" ]; then
  cmake -S "$VENDOR/Crow" -B "$VENDOR/Crow/build" -G Ninja -DCROW_BUILD_EXAMPLES=OFF -DCROW_BUILD_TESTS=OFF \
    -DCMAKE_INSTALL_PREFIX="$VENDOR/crow-install" >/dev/null
  cmake --install "$VENDOR/Crow/build" >/dev/null
fi

if [ ! -d "$VENDOR/OdbDesign" ]; then
  git clone --quiet https://github.com/nam20485/OdbDesign "$VENDOR/OdbDesign"
  git -C "$VENDOR/OdbDesign" checkout --quiet "$ODBDESIGN_REF"
  for p in "$HERE"/patches/*.patch; do git -C "$VENDOR/OdbDesign" apply "$p"; done
fi

cmake -S "$HERE" -B "$HERE/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$VENDOR/crow-install"
cmake --build "$HERE/build" --target odbpp -j"$(nproc 2>/dev/null || echo 4)"
cmake --install "$HERE/build" --prefix "$HERE/lib" >/dev/null
echo "built $HERE/lib/libodbpp.so"
