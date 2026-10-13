#!/usr/bin/env bash
# Builds a deployable bundle: deploy/out/slither.tar.gz containing the server binary and the
# built website. Run it on Linux x86_64 (a server or CI), because the binary must match the
# servers; a build on macOS produces a Mac binary that will not run there.
#
# The website bakes in the arena hostnames from web/src/games/snake/servers.ts, or from
# VITE_SNAKE_ORIGINS if set, so fill those in before packaging.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/deploy/out"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "package.sh must run on Linux to produce a Linux binary (this is $(uname -s))." >&2
  exit 1
fi

(cd "$root/web" && npm ci && npm run typecheck && npm test && npm run build)
(cd "$root" && cargo test --release && cargo build --release --locked)

rm -rf "$out/slither"
mkdir -p "$out/slither/web"
cp "$root/target/release/slither-lite" "$out/slither/"
cp -R "$root/web/dist" "$out/slither/web/dist"
cp "$root/deploy/slither@.service" "$root/deploy/region.env.example" "$root/deploy/paper.env.example" "$root/deploy/install.sh" "$out/slither/"
tar -C "$out" -czf "$out/slither.tar.gz" slither
echo "Bundle ready: $out/slither.tar.gz"
