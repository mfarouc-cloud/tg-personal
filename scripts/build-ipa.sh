#!/usr/bin/env bash
# Trigger the macOS (GitHub Actions) IPA build from any Linux box (e.g. Oracle
# Linux server) and download the result. Requires: git, gh (authenticated with
# `gh auth login`), push access to the repo.
#
#   ./scripts/build-ipa.sh                 # build current main
#   ./scripts/build-ipa.sh com.x.y.TEAMID  # build with a custom Bundle ID
set -euo pipefail
REPO="${REPO:-mfarouc-cloud/tg-personal}"
OUT="${OUT:-./ipa-out}"
BID="${1:-}"

if [[ -n "$BID" ]]; then
  gh workflow run ios.yml -R "$REPO" --ref main -f bundle_id="$BID"
else
  gh workflow run ios.yml -R "$REPO" --ref main
fi
sleep 8
RUN_ID=$(gh run list -R "$REPO" --workflow ios.yml --limit 1 --json databaseId -q '.[0].databaseId')
echo "run: $RUN_ID"
gh run watch "$RUN_ID" -R "$REPO" --exit-status --interval 20
mkdir -p "$OUT"
gh run download "$RUN_ID" -R "$REPO" -D "$OUT"
find "$OUT" -name '*.ipa' -exec ls -la {} \;
