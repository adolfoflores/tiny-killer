#!/bin/sh
# Build Tiny Killer from this checkout and install it in /Applications.
# A local build is not quarantined, so macOS opens it without the Gatekeeper prompt
# that downloaded copies get.
set -e

APP_NAME="Tiny Killer"
BUILT_APP="dist/$APP_NAME.app"
TARGET="/Applications/$APP_NAME.app"

# For this Mac's CPU only; the release build adds --universal --dmg
tinyjs build

# Quit your running copy before replacing it (its launcher binary is "tiny-killer"),
# waiting up to 5 seconds for it to go
if pgrep -u "$USER" -x tiny-killer >/dev/null; then
  pkill -u "$USER" -x tiny-killer
  for _ in $(seq 25); do
    pgrep -u "$USER" -x tiny-killer >/dev/null || break
    sleep 0.2
  done
fi

rm -rf "$TARGET"
ditto "$BUILT_APP" "$TARGET"
open "$TARGET"
echo "Installed $TARGET"
