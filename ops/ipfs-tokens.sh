#!/usr/bin/env bash
# Writes the forum IPFS node's three RPC bearer tokens (ops/ipfs-init.sh), one per
# client, to secrets/ipfs-token-{sync,api,backup}.env (IPFS_TOKEN_SYNC, IPFS_TOKEN_API,
# IPFS_TOKEN_BACKUP): 64 hex characters from `openssl rand`, each file mode 600 (secrets/
# itself is created mode 700). A token is never printed and never passed on a command line.
#
# An existing file is kept, so a re-run only fills in what is missing; --rotate
# replaces all three. Compose reads the files (env_file) when a container is created,
# so after writing, recreate the node and its three clients — ipfs,
# governance-content-sync, forum-backup and api — so they hold the same tokens: the
# node enforces authorization only with all three set, and a client holding an old
# token is refused.
#
# Usage: ops/ipfs-tokens.sh [--rotate]
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
command -v openssl >/dev/null || { echo "ipfs-tokens: openssl is required" >&2; exit 1; }

rotate=0
case "${1:-}" in
  "") ;;
  --rotate) rotate=1 ;;
  *) echo "usage: ops/ipfs-tokens.sh [--rotate]" >&2; exit 2 ;;
esac

# Created mode 700 (umask) when missing; an existing directory keeps its mode.
mkdir -p secrets

for client in sync api backup; do
  file="secrets/ipfs-token-$client.env"
  var="IPFS_TOKEN_$(printf '%s' "$client" | tr '[:lower:]' '[:upper:]')"
  if [[ -e "$file" && $rotate == 0 ]]; then
    echo "ipfs-tokens: $file exists, kept"
    continue
  fi
  token="$(openssl rand -hex 32)"
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || { echo "ipfs-tokens: openssl returned no 64-hex token" >&2; exit 1; }
  tmp="$(mktemp "secrets/.ipfs-token-$client.XXXXXX")"
  printf '%s=%s\n' "$var" "$token" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  unset token
  echo "ipfs-tokens: wrote $file"
done
