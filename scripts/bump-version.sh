#!/usr/bin/env bash
# One-command cache-buster bump. Keeps the version markers in step:
# the HTML ?v= query strings, the ?v= on every asset referenced from CSS,
# booking.js SITE_VERSION (stale-tab self-heal), and version.txt (what live
# tabs poll). Bumping them separately risks either a dead self-heal (js ahead)
# or a once-per-wake reload tax (file ahead).
#
# THE CSS ONES MATTER AS MUCH AS THE HTML ONES. The weave masks reach the
# browser only through url() in a stylesheet, never through an <img>, so for
# v76->v77 they shipped with no query string at all: the HTML and the swirl
# cache-busted, the mask did not, and a browser holding the previous mask kept
# compositing the OLD feathered weave over the NEW ribbon — the fix was on the
# server and invisible in the tab. Same exposure for cream.webp and the
# self-hosted Poppins faces. If you add a url() to a stylesheet, give it ?v=
# and it maintains itself from here.
set -e
cd "$(dirname "$0")/.."
CUR=$(cat version.txt)
NEXT=$((CUR + 1))
sed -i "s/?v=$CUR/?v=$NEXT/g" *.html
sed -i "s/?v=$CUR/?v=$NEXT/g" src/input.css css/pages/*.css
sed -i "s/const SITE_VERSION = \"$CUR\"/const SITE_VERSION = \"$NEXT\"/" booking.js
echo "$NEXT" > version.txt

# Anything a stylesheet loads without a ?v= is a file that CANNOT be busted.
STALE=$(grep -rho 'url(["'"'"']\?\.\./[^)]*)' src/input.css css/pages/*.css | grep -v '?v=' || true)
if [ -n "$STALE" ]; then
  echo "WARNING: these CSS url()s carry no ?v= and will go stale in browsers:" >&2
  echo "$STALE" | sed 's/^/  /' >&2
fi

echo "v$CUR -> v$NEXT"
