import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

async function walkDirectory(customerId, customerDir, currentDir = customerDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const rows = [];

  for (const entry of entries) {
    if (entry.name.endsWith('.uploading') || entry.isSymbolicLink()) continue;

    const absolutePath = path.join(currentDir, entry.name);
    let details;
    try {
      details = await stat(absolutePath);
    } catch {
      continue;
    }

    rows.push({
      customer_id: customerId,
      relative_path: path.relative(customerDir, absolutePath),
      name: entry.name,
      is_directory: details.isDirectory(),
      file_size: details.isFile() ? details.size : null,
      modified_at: details.mtime.toISOString(),
      indexed_at: new Date().toISOString(),
    });

    if (details.isDirectory()) {
      rows.push(...await walkDirectory(customerId, customerDir, absolutePath));
    }
  }

  return rows;
}

async function indexCustomerFolder(supabase, nasRoot, customer) {
  if (!customer.nas_folder_path || path.isAbsolute(customer.nas_folder_path)) return false;

  const root = path.resolve(nasRoot);
  const customerDir = path.resolve(root, customer.nas_folder_path);
  if (!customerDir.startsWith(root + path.sep)) return false;

  try {
    const details = await stat(customerDir);
    if (!details.isDirectory()) return false;
  } catch {
    return false;
  }

  const rows = await walkDirectory(customer.id, customerDir);

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from('customer_nas_files')
      .upsert(rows.slice(i, i + 500), { onConflict: 'customer_id,relative_path' });
    if (error) throw error;
  }

  const { data: existing, error: existingError } = await supabase
    .from('customer_nas_files')
    .select('id,relative_path')
    .eq('customer_id', customer.id);
  if (existingError) throw existingError;

  const currentPaths = new Set(rows.map(row => row.relative_path));
  const staleIds = (existing || [])
    .filter(row => !currentPaths.has(row.relative_path))
    .map(row => row.id);

  for (let i = 0; i < staleIds.length; i += 500) {
    const { error } = await supabase
      .from('customer_nas_files')
      .delete()
      .in('id', staleIds.slice(i, i + 500));
    if (error) throw error;
  }

  return true;
}

export async function refreshNasIndex(supabase, nasRoot) {
  const { data: customers, error } = await supabase
    .from('customers')
    .select('id,nas_folder_path')
    .not('nas_folder_path', 'is', null)
    .neq('nas_folder_path', '');
  if (error) throw error;

  let indexed = 0;
  for (const customer of customers || []) {
    try {
      if (await indexCustomerFolder(supabase, nasRoot, customer)) indexed += 1;
    } catch (error) {
      console.error(`[customer ${customer.id}] NAS indexing failed:`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`NAS folder index refreshed for ${indexed} mapped customer${indexed === 1 ? '' : 's'}.`);
}

