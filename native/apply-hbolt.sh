#!/usr/bin/env bash
# Applies HBOLT changes on top of a Telegram-iOS checkout. Usage: apply-hbolt.sh <telegram-ios-dir>
set -euo pipefail
T="$1"; HERE="$(cd "$(dirname "$0")" && pwd)"
# 1) Branding: home-screen name
python3 - "$T/Telegram/BUILD" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
s=s.replace("<key>CFBundleDisplayName</key>\n    <string>Telegram</string>","<key>CFBundleDisplayName</key>\n    <string>HBOLT</string>",1)
open(p,"w").write(s)
PY
grep -q "<string>HBOLT</string>" "$T/Telegram/BUILD" || { echo "branding patch failed"; exit 1; }
# 2) Source patches (features), applied in order
shopt -s nullglob
for p in "$HERE"/patches/*.patch; do echo "applying $(basename "$p")"; git -C "$T" apply --whitespace=nowarn "$p"; done
echo "HBOLT changes applied"
