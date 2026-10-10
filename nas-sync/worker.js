import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { open, readdir, rename, stat, mkdir, chown, chmod, rmdir } from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NAS_ROOT = process.env.NAS_ROOT || '/data/Clients';
const POLL_SECONDS = Math.max(10, Number(process.env.POLL_SECONDS || 30));
const BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.BATCH_SIZE || 5)));
const DELETE_STAGING_AFTER_SYNC = String(process.env.DELETE_STAGING_AFTER_SYNC || 'false').toLowerCase() === 'true';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

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
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function alphabeticalBucket(customerName) {
  const match = sanitizeSegment(customerName, 'Customer').match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : '#';
}

function validateNewCustomerPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const normalized = path.normalize(relativePath);
  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length !== 2) return null;
  const [bucket, requestedName] = parts;
  const folderName = sanitizeSegment(requestedName, 'Customer');
  if (requestedName !== folderName) return null;
  if (bucket !== alphabeticalBucket(folderName)) return null;
  return path.join(bucket, folderName);
}

function safeMappedPath(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(NAS_ROOT);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function levenshtein(a, b) {
  const left = normalizeFolderName(a);
  const right = normalizeFolderName(b);
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}

function similarityScore(a, b) {
  const left = normalizeFolderName(a);
  const right = normalizeFolderName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  return Math.max(0, 1 - levenshtein(left, right) / Math.max(left.length, right.length));
}

async function folderSuggestions(customerName) {
  const letter = alphabeticalBucket(customerName);
  const letterDir = path.join(NAS_ROOT, letter);
  let entries = [];
  try {
    entries = await readdir(letterDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: path.relative(NAS_ROOT, path.join(letterDir, entry.name)), score: similarityScore(customerName, entry.name) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5);
}

async function prepareRouting(upload) {
  const { data: customer, error } = await supabase.from('customers').select('id,name,nas_folder_path').eq('id', upload.customer_id).single();
  if (error) throw error;

  const mapped = safeMappedPath(customer.nas_folder_path);
  if (mapped) {
    try {
      const mappedStat = await stat(mapped);
      if (mappedStat.isDirectory()) {
        await supabase.from('customer_uploads').update({ sync_status: 'pending', routing_path: customer.nas_folder_path, routing_create_new: false, routing_suggestions: [] }).eq('id', upload.id);
        return;
      }
    } catch {}
  }

  const suggestions = await folderSuggestions(customer.name);
  const exact = suggestions.filter(item => normalizeFolderName(item.name) === normalizeFolderName(customer.name));
  if (exact.length === 1) {
    const selected = exact[0];
    const { error: mapError } = await supabase.from('customers').update({ nas_folder_path: selected.path }).eq('id', customer.id);
    if (mapError) throw mapError;
    const { error: uploadError } = await supabase.from('customer_uploads').update({ sync_status: 'pending', routing_path: selected.path, routing_create_new: false, routing_suggestions: suggestions }).eq('id', upload.id);
    if (uploadError) throw uploadError;
    console.log(`[${upload.id}] exact NAS folder match -> ${selected.path}`);
    return;
  }

  const { error: reviewError } = await supabase.from('customer_uploads').update({ routing_suggestions: suggestions }).eq('id', upload.id);
  if (reviewError) throw reviewError;
  console.log(`[${upload.id}] awaiting routing review`);
}

// New NAS directories follow their parent rather than Docker's user/umask.
// Existing directories are never changed by the upload worker.
async function ensureNasDirectory(directory) {
  const root = path.resolve(NAS_ROOT);
  const target = path.resolve(directory);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('NAS directory is outside NAS_ROOT.');
  }
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error('NAS_ROOT is not a directory.');
  let parent = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    const current = path.join(parent, segment);
    try {
      const existing = await stat(current);
      if (!existing.isDirectory()) throw new Error('NAS destination is not a directory.');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      const parentStat = await stat(parent);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (createError) {
        // Another process may have created this directory in the meantime.
        if (createError?.code !== 'EEXIST') throw createError;
        if (!(await stat(current)).isDirectory()) throw createError;
        parent = current;
        continue;
      }
      try {
        const created = await stat(current);
        if (created.uid !== parentStat.uid || created.gid !== parentStat.gid) {
          await chown(current, parentStat.uid, parentStat.gid);
        }
        // chmod after chown also restores an inherited setgid bit.
        await chmod(current, parentStat.mode & 0o2777);
      } catch (permissionError) {
        // Do not leave a partially configured empty directory for the next poll.
        await rmdir(current).catch(() => {});
        throw permissionError;
      }
    }
    parent = current;
  }
}

async function resolveCustomerDirectory(upload, customer) {
  const relativePath = upload.routing_path || customer.nas_folder_path;
  const resolved = safeMappedPath(relativePath);
  if (!resolved) throw new Error('Customer NAS folder has not been confirmed.');

  if (upload.routing_create_new) {
    const approvedRelativePath = validateNewCustomerPath(relativePath);
    if (!approvedRelativePath || approvedRelativePath !== relativePath) {
      throw new Error('Requested new customer folder path is invalid.');
    }

    const parentDir = path.dirname(resolved);
    await ensureNasDirectory(parentDir);
    try {
      const existing = await stat(resolved);
      if (!existing.isDirectory()) throw new Error('New customer destination already exists and is not a directory.');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        await ensureNasDirectory(resolved);
        console.log(`[customer ${customer.id}] created NAS folder -> ${relativePath}`);
      } else {
        throw err;
      }
    }
  } else {
    const resolvedStat = await stat(resolved);
    if (!resolvedStat.isDirectory()) throw new Error('Confirmed NAS destination is not a directory.');
  }

  if (customer.nas_folder_path !== relativePath) {
    const { error } = await supabase.from('customers').update({ nas_folder_path: relativePath }).eq('id', customer.id);
    if (error) throw error;
  }
  return resolved;
}

async function uniqueDestination(dir, fileName, uploadId) {
  const safeName = sanitizeSegment(fileName, 'upload');
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const preferred = path.join(dir, safeName);
  try { await stat(preferred); } catch { return preferred; }
  return path.join(dir, `${base} - ${uploadId.slice(0, 8)}${ext}`);
}

async function writeBlobAtomically(blob, destination) {
  await ensureNasDirectory(path.dirname(destination));
  const directoryStat = await stat(path.dirname(destination));
  const tempPath = `${destination}.uploading`;
  const buffer = Buffer.from(await blob.arrayBuffer());
  const hash = createHash('sha256').update(buffer).digest('hex');
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(buffer);
    const created = await handle.stat();
    if (created.uid !== directoryStat.uid || created.gid !== directoryStat.gid) {
      await handle.chown(directoryStat.uid, directoryStat.gid);
    }
    // Uploaded documents need the parent's read/write access, not execute bits.
    await handle.chmod(directoryStat.mode & 0o666);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(tempPath, destination);
  const saved = await stat(destination);
  if (saved.size !== buffer.length) throw new Error('File verification failed after NAS write.');
  return { hash, size: saved.size };
}

async function syncUpload(upload) {
  const { data: customer, error: customerError } = await supabase.from('customers').select('id,name,nas_folder_path').eq('id', upload.customer_id).single();
  if (customerError) throw customerError;
  const customerDir = await resolveCustomerDirectory(upload, customer);

  let orderRef = null;
  if (upload.order_id) {
    const { data: order, error: orderError } = await supabase.from('orders').select('id,order_ref').eq('id', upload.order_id).single();
    if (orderError) throw orderError;
    orderRef = order?.order_ref || upload.order_id;
  }

  const destinationDir = orderRef
    ? path.join(customerDir, 'Orders', sanitizeSegment(orderRef, 'Order'), sanitizeSegment(upload.category || 'Customer Uploads'))
    : customerDir;
  const destination = await uniqueDestination(destinationDir, upload.file_name, upload.id);

  const { data: blob, error: downloadError } = await supabase.storage.from('customer-uploads').download(upload.storage_path);
  if (downloadError) throw downloadError;
  const verified = await writeBlobAtomically(blob, destination);
  if (Number(upload.file_size) !== verified.size) throw new Error(`Size mismatch: expected ${upload.file_size}, wrote ${verified.size}`);

  const relativeNasPath = path.relative(NAS_ROOT, destination);
  const { error: updateError } = await supabase.from('customer_uploads').update({
    sync_status: 'synced', nas_path: relativeNasPath, synced_at: new Date().toISOString(), sync_error: null, sha256: verified.hash
  }).eq('id', upload.id);
  if (updateError) throw updateError;

  if (DELETE_STAGING_AFTER_SYNC) {
    const { error: removeError } = await supabase.storage.from('customer-uploads').remove([upload.storage_path]);
    if (removeError) console.error(`[${upload.id}] synced but staging cleanup failed:`, removeError.message);
  }
  console.log(`[${upload.id}] synced -> ${relativeNasPath}`);
}

async function pollOnce() {
  const { data: reviews, error: reviewError } = await supabase.from('customer_uploads')
    .select('id,customer_id,created_at').eq('sync_status', 'awaiting_routing').order('created_at', { ascending: true }).limit(BATCH_SIZE);
  if (reviewError) throw reviewError;
  for (const upload of reviews || []) {
    try { await prepareRouting(upload); } catch (err) { console.error(`[${upload.id}] routing review failed:`, err instanceof Error ? err.message : err); }
  }

  const { data: pending, error } = await supabase.from('customer_uploads')
    .select('id,customer_id,order_id,storage_path,file_name,file_size,mime_type,category,created_at,routing_path,routing_create_new')
    .eq('sync_status', 'pending').order('created_at', { ascending: true }).limit(BATCH_SIZE);
  if (error) throw error;

  for (const upload of pending || []) {
    const { data: claimed, error: claimError } = await supabase.from('customer_uploads')
      .update({ sync_status: 'syncing', sync_error: null }).eq('id', upload.id).eq('sync_status', 'pending').select('id').maybeSingle();
    if (claimError) { console.error(`[${upload.id}] claim failed:`, claimError.message); continue; }
    if (!claimed) continue;
    try {
      await syncUpload(upload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${upload.id}] sync failed:`, message);
      await supabase.from('customer_uploads').update({ sync_status: 'error', sync_error: message.slice(0, 1000) }).eq('id', upload.id);
    }
  }
}

console.log(`Xfinity NAS sync started. Root: ${NAS_ROOT}. Poll: ${POLL_SECONDS}s.`);
for (;;) {
  try { await pollOnce(); } catch (err) { console.error('Poll failed:', err instanceof Error ? err.message : err); }
  await new Promise(resolve => setTimeout(resolve, POLL_SECONDS * 1000));
}
