import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NAS_ROOT = process.env.NAS_ROOT || '/data/Customers';
const POLL_SECONDS = Math.max(10, Number(process.env.POLL_SECONDS || 30));
const BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.BATCH_SIZE || 5)));
const DELETE_STAGING_AFTER_SYNC = String(process.env.DELETE_STAGING_AFTER_SYNC || 'false').toLowerCase() === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

function sanitizeSegment(value, fallback = 'Unknown') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || fallback).slice(0, 140);
}

async function uniqueDestination(dir, fileName, uploadId) {
  const safeName = sanitizeSegment(fileName, 'upload');
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const preferred = path.join(dir, safeName);
  try {
    await stat(preferred);
  } catch {
    return preferred;
  }
  return path.join(dir, `${base} - ${uploadId.slice(0, 8)}${ext}`);
}

async function writeBlobAtomically(blob, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.uploading`;
  const buffer = Buffer.from(await blob.arrayBuffer());
  const hash = createHash('sha256').update(buffer).digest('hex');
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, destination);
  const saved = await stat(destination);
  if (saved.size !== buffer.length) throw new Error('File verification failed after NAS write.');
  return { hash, size: saved.size };
}

async function syncUpload(upload) {
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('id,name')
    .eq('id', upload.customer_id)
    .single();
  if (customerError) throw customerError;

  let orderRef = null;
  if (upload.order_id) {
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id,order_ref')
      .eq('id', upload.order_id)
      .single();
    if (orderError) throw orderError;
    orderRef = order?.order_ref || upload.order_id;
  }

  const customerFolder = `${customer.id} - ${sanitizeSegment(customer.name, 'Customer')}`;
  const destinationDir = orderRef
    ? path.join(NAS_ROOT, customerFolder, 'Orders', sanitizeSegment(orderRef, 'Order'), sanitizeSegment(upload.category || 'Customer Uploads'))
    : path.join(NAS_ROOT, customerFolder, sanitizeSegment(upload.category || 'Customer Uploads'));

  const destination = await uniqueDestination(destinationDir, upload.file_name, upload.id);

  const { data: blob, error: downloadError } = await supabase.storage
    .from('customer-uploads')
    .download(upload.storage_path);
  if (downloadError) throw downloadError;

  const verified = await writeBlobAtomically(blob, destination);
  if (Number(upload.file_size) !== verified.size) {
    throw new Error(`Size mismatch: expected ${upload.file_size}, wrote ${verified.size}`);
  }

  const relativeNasPath = path.relative(NAS_ROOT, destination);
  const { error: updateError } = await supabase
    .from('customer_uploads')
    .update({
      sync_status: 'synced',
      nas_path: relativeNasPath,
      synced_at: new Date().toISOString(),
      sync_error: null,
      sha256: verified.hash
    })
    .eq('id', upload.id);
  if (updateError) throw updateError;

  if (DELETE_STAGING_AFTER_SYNC) {
    const { error: removeError } = await supabase.storage.from('customer-uploads').remove([upload.storage_path]);
    if (removeError) console.error(`[${upload.id}] synced but staging cleanup failed:`, removeError.message);
  }

  console.log(`[${upload.id}] synced -> ${relativeNasPath}`);
}

async function pollOnce() {
  const { data: pending, error } = await supabase
    .from('customer_uploads')
    .select('id,customer_id,order_id,storage_path,file_name,file_size,mime_type,category,created_at')
    .eq('sync_status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  for (const upload of pending || []) {
    const { data: claimed, error: claimError } = await supabase
      .from('customer_uploads')
      .update({ sync_status: 'syncing', sync_error: null })
      .eq('id', upload.id)
      .eq('sync_status', 'pending')
      .select('id')
      .maybeSingle();
    if (claimError) {
      console.error(`[${upload.id}] claim failed:`, claimError.message);
      continue;
    }
    if (!claimed) continue;

    try {
      await syncUpload(upload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${upload.id}] sync failed:`, message);
      await supabase
        .from('customer_uploads')
        .update({ sync_status: 'error', sync_error: message.slice(0, 1000) })
        .eq('id', upload.id);
    }
  }
}

console.log(`Xfinity NAS sync started. Root: ${NAS_ROOT}. Poll: ${POLL_SECONDS}s.`);
for (;;) {
  try {
    await pollOnce();
  } catch (err) {
    console.error('Poll failed:', err instanceof Error ? err.message : err);
  }
  await new Promise(resolve => setTimeout(resolve, POLL_SECONDS * 1000));
}
