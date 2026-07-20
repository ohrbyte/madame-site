#!/usr/bin/env bash
# One-command cache-buster bump. Keeps the three version markers in step:
# the HTML ?v= query strings, booking.js SITE_VERSION (stale-tab self-heal),
# and version.txt (what live tabs poll). Bumping them separately risks either
# a dead self-heal (js ahead) or a once-per-wake reload tax (file ahead).
set -e
cd "$(dirname "$0")/.."
CUR=$(cat version.txt)
NEXT=$((CUR + 1))
sed -i "s/?v=$CUR/?v=$NEXT/g" *.html
sed -i "s/const SITE_VERSION = \"$CUR\"/const SITE_VERSION = \"$NEXT\"/" booking.js
echo "$NEXT" > version.txt
echo "v$CUR -> v$NEXT"
