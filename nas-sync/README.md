# Xfinity Media NAS Sync

This worker moves staged customer uploads from the private Supabase `customer-uploads` bucket into the Xfinity Media customer folder structure on the NAS.

## Folder layout

Files without an order are written to:

`Customers/{customer UUID} - {customer name}/Customer Uploads/{file name}`

If an upload is later linked to an order, the worker writes it to:

`Customers/{customer UUID} - {customer name}/Orders/{order ref}/{category}/{file name}`

## Required environment variables

Create a `.env` file beside `docker-compose.yml` on the NAS. Do not commit it.

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
NAS_CUSTOMERS_PATH=/volume1/Xfinity Media/Customers
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
