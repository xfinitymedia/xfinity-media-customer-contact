// XM_RECYCLE_BOUNDARY_V1: no interactive XM role can access NAS recovery.
const xmRecoverySegment=value=>typeof value==='string'&&value.normalize('NFKC').split(/[\\/]/).some(part=>part.toLowerCase()==='#recycle');
const xmAssertRecoveryPaths=(...values)=>{if(values.some(xmRecoverySegment))throw Error('This NAS location is not accessible through XM');};
// XM_LARGE_DOWNLOADS_V1: customer-folder files up to 1 GB, streamed to the cache without buffering.
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 1024 ** 3;
const BUCKET = 'nas-file-access';
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TOO_LARGE = 'Files larger than 1 GB must be opened through Finder.';
const CHANGED = 'File changed while reading. Please try again.';

function segments(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new Error('Invalid file path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid file path.');
  return parts;
}

// Opens a customer-folder file after the same path, link and boundary checks as before.
// The caller must close the returned handle.
export async function openRequestedFile(nasRoot, folderPath, relativePath) {
  xmAssertRecoveryPaths(nasRoot, folderPath, relativePath);
  const root = await realpath(nasRoot);
  const folderParts = segments(folderPath);
  const parts = [...folderParts, ...segments(relativePath)];
  let target = root;
  let customerRoot;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Links cannot be opened through XM.');
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('File path is not a directory.');
    if (index === parts.length - 1 && !info.isFile()) throw new Error('Only files can be opened.');
    if (index === folderParts.length - 1) customerRoot = await realpath(target);
  }
  const canonical = await realpath(target);
  if (!canonical.startsWith(root + path.sep) || !canonical.startsWith(customerRoot + path.sep)) throw new Error('File is outside the customer folder.');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Only files can be opened.');
    if (before.size > MAX_FILE_BYTES) throw new Error(TOO_LARGE);
    return { handle, before };
  } catch (error) { await handle.close(); throw error; }
}

async function assertUnchanged(handle, before) {
  const after = await handle.stat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(CHANGED);
}

// Kept for compatibility with existing checks. Buffers the whole file, so the worker no longer uses it.
export async function readRequestedFile(nasRoot, folderPath, relativePath) {
  const { handle, before } = await openRequestedFile(nasRoot, folderPath, relativePath);
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      total += chunk.length;
      if (total > MAX_FILE_BYTES) throw new Error(TOO_LARGE);
      chunks.push(chunk);
    }
    await assertUnchanged(handle, before);
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

// Streams an open file to the private cache through a one-time signed upload URL.
// Memory use stays at one read chunk regardless of file size.
export async function uploadOpenFile(supabase, storagePath, handle, size, contentType, deadline, fetchImpl = fetch) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error('Could not prepare the file cache.');
  let sent = 0;
  async function* body() {
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      sent += chunk.length;
      if (sent > size) throw new Error(CHANGED);
      yield chunk;
    }
  }
  let response;
  try {
    response = await fetchImpl(data.signedUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'cache-control': 'max-age=0', 'x-upsert': 'false', 'content-length': String(size) },
      body: body(), duplex: 'half',
      signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
    });
  } catch (error) {
    if (sent > size) throw new Error(CHANGED);
    throw error;
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.text()).slice(0, 160); } catch { /* Status alone is enough. */ }
    throw new Error(`Could not copy the file to the download cache (${response.status}). ${detail}`.trim());
  }
  if (sent !== size) throw new Error(CHANGED);
}

export async function processFileRequest(supabase, nasRoot, job) {
  const storagePath = job.id + '/' + (path.basename(job.file_name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file');
  let attempted = false;
  try {
    const { data: customer, error: customerError } = await supabase.from('customers').select('nas_folder_path').eq('id', job.customer_id).single();
    if (customerError) throw customerError;
    if (customer.nas_folder_path !== job.customer_folder_path) throw new Error('Customer folder mapping changed. Please try again.');
    const { data: file, error: fileError } = await supabase.from('customer_nas_files').select('relative_path,is_directory').eq('id', job.file_id).eq('customer_id', job.customer_id).single();
    if (fileError || !file || file.is_directory) throw new Error('File is no longer available. Refresh the customer folder.');
    if (file.relative_path !== job.relative_path) throw new Error('File is no longer available. Refresh the customer folder.');
    const deadline = Date.parse(job.expires_at);
    if (!(deadline > Date.now())) throw new Error('File request expired. Please try again.');
    const { handle, before } = await openRequestedFile(nasRoot, job.customer_folder_path, job.relative_path);
    try {
      attempted = true;
      const contentType = MIME[path.extname(job.file_name).toLowerCase()] || 'application/octet-stream';
      await uploadOpenFile(supabase, storagePath, handle, before.size, contentType, deadline);
      await assertUnchanged(handle, before);
    } finally { await handle.close(); }
    if (Date.parse(job.expires_at) <= Date.now()) throw new Error('File request expired. Please try again.');
    const { data: saved, error } = await supabase.from('nas_file_access_requests').update({ status: 'ready', storage_path: storagePath, error_message: null }).eq('id', job.id).select('id').maybeSingle();
    if (error) throw error;
    if (!saved) throw new Error('File request is no longer available.');
  } catch (error) {
    // Removing a cache object that was never written is harmless.
    if (attempted) await supabase.storage.from(BUCKET).remove([storagePath]);
    const message = error?.code === 'ENOENT' ? 'File is no longer on the NAS. Refresh the customer folder.'
      : ['EACCES', 'EPERM'].includes(error?.code) ? 'The NAS service cannot read this file.'
      : error?.name === 'TimeoutError' ? 'The file took too long to copy from the NAS. Please try again.'
      : error instanceof Error ? error.message : 'Could not retrieve this file.';
    const { error: updateError } = await supabase.from('nas_file_access_requests').update({ status: 'error', error_message: message.slice(0, 300) }).eq('id', job.id);
    if (updateError) throw updateError;
  }
}

export async function pollFileRequests(supabase, nasRoot) {
  const now = new Date().toISOString();
  const { data: expired, error: expiryError } = await supabase.from('nas_file_access_requests').select('id,storage_path,file_name').lt('expires_at', now).limit(50);
  if (expiryError) throw expiryError;
  for (const job of expired || []) {
    // Include a worker interrupted after upload but before recording storage_path.
    const cachePath = job.storage_path || job.id + '/' + (path.basename(job.file_name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file');
    const { error: cleanupError } = await supabase.storage.from(BUCKET).remove([cachePath]);
    if (cleanupError) continue;
    const { error } = await supabase.from('nas_file_access_requests').delete().eq('id', job.id);
    if (error) throw error;
  }
  const { data: pending, error } = await supabase.from('nas_file_access_requests').select('*').eq('status', 'pending').gt('expires_at', now).order('created_at').limit(3);
  if (error) throw error;
  for (const job of pending || []) {
    const { data: claimed, error: claimError } = await supabase.from('nas_file_access_requests').update({ status: 'processing' }).eq('id', job.id).eq('status', 'pending').select('id').maybeSingle();
    if (claimError) throw claimError;
    if (claimed) await processFileRequest(supabase, nasRoot, job);
  }
}

export async function fileAccessLoop(supabase, nasRoot) {
  console.log('NAS file access started. Poll: 3s. Limit: 1 GB.');
  for (;;) {
    try { await pollFileRequests(supabase, nasRoot); }
    catch (error) { console.error('NAS file access failed:', error instanceof Error ? error.message : 'Request failed'); }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
