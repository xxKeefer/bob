#!/bin/sh
set -eu

prefix="${BOB_PREFIX:-$HOME/.local/share/bob}"
bindir="${BOB_BIN:-$HOME/.local/bin}"
here=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "bob needs Node 26 or later, and node is not on PATH." >&2
  echo "Install Node 26 (https://nodejs.org), then run install.sh again." >&2
  exit 1
fi

found=$(node --version)
major=${found#v}
major=${major%%.*}
case "$major" in
  '' | *[!0-9]*) major=0 ;;
esac

if [ "$major" -lt 26 ]; then
  echo "bob needs Node 26 or later, and found $found." >&2
  echo "Install Node 26 (https://nodejs.org), then run install.sh again." >&2
  exit 1
fi

mkdir -p "$prefix" "$bindir"
rm -rf "${prefix:?}/bin" "${prefix:?}/src" "${prefix:?}/layouts"
cp -R "$here/bin" "$here/src" "$here/layouts" "$prefix/"
cp "$here/package.json" "$here/README.md" "$here/install.sh" "$prefix/"
chmod +x "$prefix/bin/bob.ts"
ln -sf "$prefix/bin/bob.ts" "$bindir/bob"

echo "Installed bob to $prefix"
echo "Linked $bindir/bob"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "Add $bindir to your PATH to run bob." ;;
esac
echo "Next: bob install --write"
