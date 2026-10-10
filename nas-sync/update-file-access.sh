#!/bin/sh
set -eu
revision=${1:?Pass the tested Git commit to install}
case "$revision" in *[!0-9a-f]*|'') echo "Invalid commit" >&2; exit 1;; esac
cd /volume1/Docker/xfinity-nas-sync
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
base="https://raw.githubusercontent.com/xfinitymedia/xfinity-media-customer-contact/$revision/nas-sync"
for file in Dockerfile worker.js nas-folder-catalog.js nas-file-access.js nas-indexer.js supervisor.js; do
  curl -fsSL "$base/$file" -o "$staging/$file"
done
for file in worker.js nas-folder-catalog.js nas-file-access.js nas-indexer.js supervisor.js; do
  sudo docker compose exec -T xfinity-nas-sync node --input-type=module --check < "$staging/$file"
done
backup="backups/file-access-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
for file in Dockerfile worker.js nas-folder-catalog.js nas-file-access.js nas-indexer.js supervisor.js; do
  if [ -f "$file" ]; then cp "$file" "$backup/$file"; fi
  cp "$staging/$file" "$file"
done
if ! sudo docker compose up -d --build; then
  echo "Build failed. Restoring the previous service files." >&2
  for file in Dockerfile worker.js nas-folder-catalog.js nas-file-access.js nas-indexer.js supervisor.js; do
    if [ -f "$backup/$file" ]; then cp "$backup/$file" "$file"; fi
  done
  sudo docker compose up -d --build
  exit 1
fi
sudo docker compose exec -T xfinity-nas-sync node --input-type=module -e 'await import("./nas-file-access.js"); console.log("NAS file access module loaded successfully.")'
sudo docker compose logs --tail=30
echo "NAS folder connection and file access update installed. Backups: $backup"
