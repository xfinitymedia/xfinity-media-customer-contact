import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readRequestedFile, MAX_FILE_BYTES, processFileRequest, pollFileRequests } from './nas-file-access.js';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xm-nas-access-'));
  try {
    await fs.mkdir(path.join(root, 'D/Customer/Artwork'), { recursive: true });
    await fs.writeFile(path.join(root, 'D/Customer/Artwork/design.pdf'), 'nas-file-content');
    await run(root);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('reads actual files without modifying the source', async () => fixture(async root => {
  const bytes = await readRequestedFile(root, 'D/Customer', 'Artwork/design.pdf');
  assert.equal(bytes.toString(), 'nas-file-content');
  assert.equal(await fs.readFile(path.join(root, 'D/Customer/Artwork/design.pdf'), 'utf8'), 'nas-file-content');
}));
test('blocks traversal, absolute paths, directories and symlinks', async () => fixture(async root => {
  for (const bad of ['../Customer/Artwork/design.pdf', '/etc/passwd', 'Artwork/../design.pdf', 'Artwork\\design.pdf']) {
    await assert.rejects(readRequestedFile(root, 'D/Customer', bad), /Invalid file path/);
  }
  await assert.rejects(readRequestedFile(root, '../D/Customer', 'Artwork/design.pdf'), /Invalid file path/);
  await assert.rejects(readRequestedFile(root, 'D/Customer', 'Artwork'), /Only files/);
  await fs.symlink(path.join(root, 'D/Customer/Artwork/design.pdf'), path.join(root, 'D/Customer/link.pdf'));
  await assert.rejects(readRequestedFile(root, 'D/Customer', 'link.pdf'), /Links cannot/);
  await fs.symlink(path.join(root, 'D/Customer/Artwork'), path.join(root, 'D/Customer/Link'));
  await assert.rejects(readRequestedFile(root, 'D/Customer', 'Link/design.pdf'), /Links cannot/);
}));
test('rejects oversized files before loading their contents', async () => fixture(async root => {
  const file = path.join(root, 'D/Customer/Artwork/large.pdf');
  const handle = await fs.open(file, 'w');
  await handle.truncate(MAX_FILE_BYTES + 1); await handle.close();
  await assert.rejects(readRequestedFile(root, 'D/Customer', 'Artwork/large.pdf'), /50 MB/);
}));

const job = { id: 'request-id', customer_id: 'customer-id', file_id: 'file-id', customer_folder_path: 'D/Customer', relative_path: 'Artwork/design.pdf', file_name: 'design.pdf', expires_at: new Date(Date.now() + 600000).toISOString() };
function mockDb({ changedMapping = false, expired = [], pending = [], cleanupFails = false } = {}) {
  const updates = [], uploads = [], removals = [], deletes = [];
  const client = {
    from(table) {
      let operation = 'select', payload, filters = [];
      const chain = {
        select() { return chain; }, eq(...args) { filters.push(args); return chain; }, gt() { return chain; }, lt() { return chain; }, order() { return chain; }, limit() { return chain; },
        update(data) { operation = 'update'; payload = data; updates.push(data); return chain; },
        delete() { operation = 'delete'; deletes.push(table); return chain; },
        async single() { return table === 'customers' ? { data: { nas_folder_path: changedMapping ? 'Other' : job.customer_folder_path } } : { data: { relative_path: job.relative_path, is_directory: false } }; },
        async maybeSingle() { return { data: { id: job.id } }; },
        then(resolve, reject) { return Promise.resolve({ data: table === 'nas_file_access_requests' && operation === 'select' ? (filters.some(([key]) => key === 'status') ? pending : expired) : null }).then(resolve, reject); },
      };
      return chain;
    },
    storage: { from() { return {
      async upload(storagePath, bytes, options) { uploads.push({ storagePath, bytes, options }); return {}; },
      async remove(paths) { removals.push(paths); return cleanupFails ? { error: new Error('storage unavailable') } : {}; },
    }; } },
  };
  return { client, updates, uploads, removals, deletes };
}
test('on-demand retrieval uploads exact bytes privately and marks ready', async () => fixture(async root => {
  const db = mockDb(); await processFileRequest(db.client, root, job);
  assert.equal(db.uploads[0].bytes.toString(), 'nas-file-content');
  assert.equal(db.uploads[0].options.contentType, 'application/pdf');
  assert.equal(db.uploads[0].options.upsert, false);
  assert.equal(db.updates.at(-1).status, 'ready');
}));
test('changed customer mapping fails without copying a file', async () => fixture(async root => {
  const db = mockDb({ changedMapping: true }); await processFileRequest(db.client, root, job);
  assert.equal(db.uploads.length, 0); assert.equal(db.updates.at(-1).status, 'error');
}));
test('expired interrupted requests remove temporary copies before their records', async () => {
  const db = mockDb({ expired: [{ ...job, storage_path: null }] });
  await pollFileRequests(db.client, '/not-used');
  assert.deepEqual(db.removals, [['request-id/design.pdf']]); assert.equal(db.deletes.length, 1);
});
test('failed storage cleanup retains the record for retry', async () => {
  const db = mockDb({ expired: [{ ...job, storage_path: 'request-id/design.pdf' }], cleanupFails: true });
  await pollFileRequests(db.client, '/not-used'); assert.equal(db.deletes.length, 0);
});
