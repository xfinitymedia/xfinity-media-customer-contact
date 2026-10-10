import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

export async function scanCustomerFolders(root) {
  const rows = [];
  const lastSeen = new Date().toISOString();
  for (const bucket of await readdir(root, { withFileTypes: true })) {
    if (!/^[A-Z#]$/.test(bucket.name) || !bucket.isDirectory() || bucket.isSymbolicLink()) continue;
    for (const folder of await readdir(path.join(root, bucket.name), { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.isSymbolicLink() || folder.name.startsWith('.') || folder.name.includes('\\')) continue;
      const details = await lstat(path.join(root, bucket.name, folder.name));
      if (details.isDirectory() && !details.isSymbolicLink()) rows.push({ path: `${bucket.name}/${folder.name}`, name: folder.name, last_seen_at: lastSeen });
    }
  }
  return rows;
}

export async function refreshFolderCatalog(supabase, root) {
  const started = new Date().toISOString();
  const rows = await scanCustomerFolders(root);
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await supabase.from('nas_customer_folders').upsert(rows.slice(offset, offset + 500), { onConflict: 'path' });
    if (error) throw error;
  }
  // Delete old entries only after a complete successful scan and publication.
  const { error } = await supabase.from('nas_customer_folders').delete().lt('last_seen_at', started);
  if (error) throw error;
}
