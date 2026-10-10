import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const BUCKET = 'nas-file-access';
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function segments(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new Error('Invalid file path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid file path.');
  return parts;
}

export async function readRequestedFile(nasRoot, folderPath, relativePath) {
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
    if (before.size > MAX_FILE_BYTES) throw new Error('Files larger than 50 MB must be opened through Finder.');
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > MAX_FILE_BYTES) throw new Error('File exceeds the 50 MB limit.');
      chunks.push(chunk);
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('File changed while reading. Please try again.');
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

export async function processFileRequest(supabase, nasRoot, job) {
  const storagePath = job.id + '/' + (path.basename(job.file_name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file');
  let uploaded = false;
  try {
    const { data: customer, error: customerError } = await supabase.from('customers').select('nas_folder_path').eq('id', job.customer_id).single();
    if (customerError) throw customerError;
    if (customer.nas_folder_path !== job.customer_folder_path) throw new Error('Customer folder mapping changed. Please try again.');
    const { data: file, error: fileError } = await supabase.from('customer_nas_files').select('relative_path,is_directory').eq('id', job.file_id).eq('customer_id', job.customer_id).single();
    if (fileError || !file || file.is_directory || file.relative_path !== job.relative_path) throw new Error('File is no longer available. Refresh the customer folder.');
    const buffer = await readRequestedFile(nasRoot, job.customer_folder_path, job.relative_path);
    if (Date.parse(job.expires_at) <= Date.now()) throw new Error('File request expired. Please try again.');
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: MIME[path.extname(job.file_name).toLowerCase()] || 'application/octet-stream',
      cacheControl: '0', upsert: false,
    });
    if (uploadError) throw uploadError;
    uploaded = true;
    const { data: saved, error } = await supabase.from('nas_file_access_requests').update({ status: 'ready', storage_path: storagePath, error_message: null }).eq('id', job.id).select('id').maybeSingle();
    if (error) throw error;
    if (!saved) throw new Error('File request is no longer available.');
  } catch (error) {
    if (uploaded) await supabase.storage.from(BUCKET).remove([storagePath]);
    const message = error?.code === 'ENOENT' ? 'File is no longer on the NAS. Refresh the customer folder.'
      : ['EACCES', 'EPERM'].includes(error?.code) ? 'The NAS service cannot read this file.'
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
  console.log('NAS file access started. Poll: 3s.');
  for (;;) {
    try { await pollFileRequests(supabase, nasRoot); }
    catch (error) { console.error('NAS file access failed:', error instanceof Error ? error.message : 'Request failed'); }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

