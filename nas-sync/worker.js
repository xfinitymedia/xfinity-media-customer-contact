import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NAS_ROOT = process.env.NAS_ROOT || '/data/Clients';
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

function normalizeFolderName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-CA')
    .replace(/\s+/g, ' ')
    .trim();
}

function alphabeticalBucket(customerName) {
  const match = sanitizeSegment(customerName, 'Customer').match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : '#';
}

function safeMappedPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(NAS_ROOT);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function resolveCustomerDirectory(customer) {
  const mapped = safeMappedPath(customer.nas_folder_path);
  if (mapped) {
    try {
      const mappedStat = await stat(mapped);
      if (mappedStat.isDirectory()) return mapped;
    } catch {
      // Folder was moved/renamed on the NAS; fall through and resolve it again by name.
    }
  }

  const folderName = sanitizeSegment(customer.name, 'Customer');
  const letter = alphabeticalBucket(folderName);
  const letterDir = path.join(NAS_ROOT, letter);
  await mkdir(letterDir, { recursive: true });

  const entries = await readdir(letterDir, { withFileTypes: true });
  const wanted = normalizeFolderName(folderName);
  const existing = entries.find(entry => entry.isDirectory() && normalizeFolderName(entry.name) === wanted);

  const customerDir = existing
    ? path.join(letterDir, existing.name)
    : path.join(letterDir, folderName);

  if (!existing) await mkdir(customerDir, { recursive: true });

  const relativeFolder = path.relative(NAS_ROOT, customerDir);
  const { error: mappingError } = await supabase
    .from('customers')
    .update({ nas_folder_path: relativeFolder })
    .eq('id', customer.id);
  if (mappingError) throw mappingError;

  console.log(`[customer ${customer.id}] NAS folder -> ${relativeFolder}${existing ? ' (matched existing)' : ' (created)'}`);
  return customerDir;
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
    .select('id,name,nas_folder_path')
    .eq('id', upload.customer_id)
    .single();
  if (customerError) throw customerError;

  const customerDir = await resolveCustomerDirectory(customer);

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

  // Customer QR uploads go directly into the existing customer folder, matching
  // the current Xfinity Shared/Clients (1)/A/Customer Name/file.ext layout.
  // Order-linked uploads retain their own structure until the existing order
  // folder convention is mapped separately.
  const destinationDir = orderRef
    ? path.join(customerDir, 'Orders', sanitizeSegment(orderRef, 'Order'), sanitizeSegment(upload.category || 'Customer Uploads'))
    : customerDir;

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
