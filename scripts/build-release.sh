#!/bin/sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out="${1:-$root/dist}"
version=$(node -p "JSON.parse(require('fs').readFileSync('$root/package.json','utf8')).version")
name="bob-$version"

mkdir -p "$out"
list=$(mktemp)
trap 'rm -f "$list"' EXIT

cd "$root"
{
  find bin src layouts -type f
  printf '%s\n' package.json README.md install.sh
} | LC_ALL=C sort >"$list"

tar --files-from="$list" --transform="s,^,$name/," --sort=name --mtime='2000-01-01 00:00:00 UTC' \
  --owner=0 --group=0 --numeric-owner --mode='u+rw,go+r,go-w' -cf - | gzip -n >"$out/$name.tar.gz"

echo "$out/$name.tar.gz"
