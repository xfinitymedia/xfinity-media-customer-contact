# Xfinity Media NAS Sync

This worker moves staged customer uploads from the private Supabase `customer-uploads` bucket into the Xfinity Media customer folder structure on the NAS.

## Folder layout

Files without an order are written to:

`{confirmed customer folder}/{file name}`

If an upload is later linked to an order, the worker writes it to:

`{confirmed customer folder}/Orders/{order ref}/{category}/{file name}`

## Required environment variables

Create a `.env` file beside `docker-compose.yml` on the NAS. Do not commit it.

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
NAS_CLIENTS_PATH=/volume1/Xfinity Shared/Clients (1)
```

The service-role key must stay only on the NAS worker. Never expose it in the customer-facing app.

## Start

From this `nas-sync` folder on the NAS:

```sh
docker compose up -d --build
```

Then inspect logs:

```sh
docker compose logs -f
```

## Sync states

`pending` -> waiting for NAS worker

`syncing` -> worker claimed the file

`synced` -> file written and size-verified on NAS

`error` -> sync failed; `sync_error` contains the reason

## Staging cleanup

`DELETE_STAGING_AFTER_SYNC` defaults to `false`. Keep it false during initial testing. After the NAS workflow has been verified and backed up, it can be changed to `true` so the Supabase staging copy is deleted only after a successful NAS write and metadata update.

## New folder and file permissions

New customer, alphabetical bucket, and order directories copy the immediate parent's numeric owner, group, and POSIX directory permissions (including setgid). This avoids Docker's default owner and umask making new customer folders read-only to NAS staff. Existing directories are not modified.

New uploads copy the destination directory's owner and group, with its read/write permission bits and no execute bits. Permissions are applied before the upload is renamed into place. A permission error fails the upload rather than marking it synced. This is POSIX ownership/mode inheritance; it does not copy arbitrary Windows ACL entries. Shared-folder access and parent ACLs must also permit staff writes.

The worker needs permission to assign the parent's ownership, as provided by the existing root-run container. If configuring a non-root container, its user/group must already match the intended NAS directory ownership.

Run filesystem regression checks from this directory:

```sh
node --test worker-permissions.test.mjs
```

To install an updated worker on the existing NAS:

```sh
cd /volume1/Docker/xfinity-nas-sync
curl -fsSL https://raw.githubusercontent.com/xfinitymedia/xfinity-media-customer-contact/main/nas-sync/worker.js -o worker.js.new
sudo docker compose exec -T xfinity-nas-sync node --input-type=module --check < worker.js.new
cp worker.js worker.js.previous
mv worker.js.new worker.js
sudo docker compose up -d --build
sudo docker compose logs --tail=30
```

Test a newly created intake folder by adding a file through Finder after restarting. Existing affected folders require a separate repair.

## Customer folder previews and downloads

The sandbox Customer Folder screen can browse indexed subfolders, preview PDFs and common raster images, and download native files. The `sandbox-nas-file-access` Edge Function authenticates the staff user, checks customer access, and queues a request by indexed file ID. Apply `supabase/nas-file-access.sql` from the backend repository and deploy that function before activating the NAS worker.

The NAS service polls every three seconds using its existing outbound Supabase connection. It validates the current customer mapping and indexed file, rejects symlinks and traversal, and copies the requested bytes into the private `nas-file-access` bucket. It never publishes a NAS HTTP port. Files above 50 MiB use Finder instead.

Temporary copies and request records expire after ten minutes and are removed by the running NAS service. If the NAS is offline, cleanup resumes when it returns. Signed links are valid for at most two minutes and are issued only to the requesting staff user after rechecking customer access. Original NAS files are not modified.

To install a tested NAS update, download `nas-sync/update-file-access.sh` from that exact commit and run `sh update-file-access.sh COMMIT_SHA` in the existing NAS SSH session. The installer stages and syntax-checks all new JavaScript files, backs up the replaced files, rebuilds the container, and restores the prior service if the build fails. The earlier `worker.js` folder-permission fix is retained.

NAS regression tests: `node --test nas-file-access.test.mjs worker-permissions.test.mjs`. Backend/UI regression tests run in the backend repository.
