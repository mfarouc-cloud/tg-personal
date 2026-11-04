#!/usr/bin/env bash
# Applies HBOLT changes on top of a Telegram-iOS checkout. Usage: apply-hbolt.sh <telegram-ios-dir>
set -euo pipefail
T="$1"; HERE="$(cd "$(dirname "$0")" && pwd)"
# 1) Branding: home-screen name "HBolt" (Info.plist templates + every localized InfoPlist.strings)
python3 - "$T" <<'PY'
import sys, re, glob, os
t = sys.argv[1]
p = os.path.join(t, "Telegram/BUILD"); s = open(p).read()
s, n = re.subn(r"(<key>CFBundleDisplayName</key>\s*<string>)Telegram(</string>)", r"\1HBolt\2", s)
open(p, "w").write(s); print("BUILD display names:", n)
for f in glob.glob(os.path.join(t, "Telegram/Telegram-iOS/*.lproj/InfoPlist.strings")):
    raw = open(f, "rb").read()
    enc = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8"
    txt = raw.decode(enc)
    new = re.sub(r'("?CFBundleDisplayName"?\s*=\s*)"[^"]*"', r'\1"HBolt"', txt)
    if new != txt: open(f, "wb").write(new.encode(enc)); print("localized:", f)
PY
grep -q "<string>HBolt</string>" "$T/Telegram/BUILD" || { echo "branding patch failed"; exit 1; }
# 1b) CFBundleName of the app itself
python3 - "$T/Telegram/BUILD" <<'PY'
import sys, re
p = sys.argv[1]; s = open(p).read()
s, n = re.subn(r"(<key>CFBundleName</key>\s*<string>)Telegram(</string>)", r"\1HBolt\2", s)
open(p, "w").write(s); print("CFBundleName:", n)
PY
# 1c) App icon: dark HBolt bolt (iOS 26 Icon Composer + classic PNG sizes)
cp "$HERE"/assets/AppIconLLC/*.png "$T/Telegram/Telegram-iOS/DefaultAppIcon.xcassets/AppIconLLC.appiconset/"
ICON="$T/Telegram/Telegram-iOS/Telegram.icon"
rm -rf "$ICON/Assets" && mkdir -p "$ICON/Assets"
cp "$HERE/assets/HBolt.png" "$ICON/Assets/HBolt.png"
cat > "$ICON/icon.json" <<'JSON'
{
  "groups" : [
    {
      "layers" : [
        {
          "image-name" : "HBolt.png",
          "name" : "HBolt"
        }
      ]
    }
  ],
  "supported-platforms" : {
    "circles" : [
      "watchOS"
    ],
    "squares" : "shared"
  }
}
JSON
# 2) Source patches (features), applied in order
shopt -s nullglob
for p in "$HERE"/patches/*.patch; do echo "applying $(basename "$p")"; git -C "$T" apply --whitespace=nowarn "$p"; done
echo "HBOLT changes applied"
