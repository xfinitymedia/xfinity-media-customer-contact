#!/bin/sh
set -eu
revision=${1:?Pass the tested Git commit to install}
case "$revision" in *[!0-9a-f]*|'') echo "Invalid commit" >&2; exit 1;; esac
[ ${#revision} -eq 40 ] || exit 1
cd /volume1/Docker/xfinity-nas-sync
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
base="https://raw.githubusercontent.com/xfinitymedia/xfinity-media-customer-contact/$revision/nas-sync"
for file in Dockerfile worker.js customer-folder-writer.mjs; do
  curl -fsSL "$base/$file" -o "$staging/$file"
done
for file in worker.js customer-folder-writer.mjs; do
  sudo docker compose exec -T xfinity-nas-sync node --input-type=module --check < "$staging/$file"
done
backup="backups/customer-uploads-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
for file in Dockerfile worker.js customer-folder-writer.mjs; do
  if [ -f "$file" ]; then cp -p "$file" "$backup/$file"; fi
  cp "$staging/$file" "$file"
done
if ! sudo docker compose up -d --build; then
  echo "Build failed. Restoring previous service files." >&2
  for file in Dockerfile worker.js; do cp -p "$backup/$file" "$file"; done
  if [ -f "$backup/customer-folder-writer.mjs" ]; then cp -p "$backup/customer-folder-writer.mjs" customer-folder-writer.mjs; fi
  sudo docker compose up -d --build
  exit 1
fi
sudo docker compose exec -T xfinity-nas-sync node --input-type=module -e 'await import("./customer-folder-writer.mjs"); console.log("Customer folder upload writer loaded.")'
sudo docker compose ps
echo "NAS upload service updated. Previous service files: $backup"
