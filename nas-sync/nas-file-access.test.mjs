// node --test deploy/nas-large-downloads/nas-file-access.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, truncate, appendFile, symlink, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openRequestedFile, readRequestedFile, processFileRequest, uploadOpenFile, MAX_FILE_BYTES } from './nas-file-access.js';

async function server(onBody) {
  const received = [];
  const srv = http.createServer(async (req, res) => {
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of req) { size += chunk.length; hash.update(chunk); await onBody?.(size); }
    received.push({ method: req.method, url: req.url, headers: req.headers, size, sha: hash.digest('hex') });
    res.writeHead(req.url.includes('fail') ? 413 : 200, { 'content-type': 'application/json' }).end('{"Key":"x"}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise(r => srv.close(r)) };
}

function fakeSupabase(base, customerPath = 'C/Customer', relative = 'Artwork/design.af', signPath = '/upload') {
  const updates = [], removed = [];
  return {
    updates, removed,
    from(table) {
      const chain = {
        select: () => chain, eq: () => chain,
        update(value) { updates.push({ table, value }); return chain; },
        async single() {
          if (table === 'customers') return { data: { nas_folder_path: customerPath } };
          return { data: { relative_path: relative, is_directory: false } };
        },
        async maybeSingle() { return { data: { id: 'job' } }; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
      };
      return chain;
    },
    storage: { from: () => ({
      async createSignedUploadUrl(p) { return { data: { signedUrl: base + signPath + '/' + p + '?token=t' } }; },
      async remove(paths) { removed.push(...paths); return { error: null }; },
    }) },
  };
}

async function fixture(size) {
  const root = await mkdtemp(path.join(tmpdir(), 'xm-nas-'));
  const dir = path.join(root, 'C', 'Customer', 'Artwork');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'design.af');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const out = createWriteStream(file); out.on('error', reject); out.on('finish', resolve);
    const block = randomBytes(1024 * 1024); let left = size;
    (function write() {
      while (left > 0) { const n = Math.min(left, block.length); const piece = block.subarray(0, n); hash.update(piece); left -= n; if (!out.write(piece)) return out.once('drain', write); }
      out.end();
    })();
  });
  return { root, file, sha: hash.digest('hex') };
}
const job = (extra = {}) => ({ id: '33333333-3333-4333-8333-333333333333', customer_id: 'c', file_id: 'f', customer_folder_path: 'C/Customer', relative_path: 'Artwork/design.af', file_name: 'XM10826 - SABTECH MERCH.af', expires_at: new Date(Date.now() + 600000).toISOString(), ...extra });

test('streams a 300 MB file intact', async () => {
  const { root, sha } = await fixture(300 * 1024 * 1024);
  const s = await server();
  try {
    const db = fakeSupabase(s.url);
    await processFileRequest(db, root, job());
    const got = s.received[0];
    assert.equal(got.method, 'PUT');
    assert.equal(got.size, 300 * 1024 * 1024);
    assert.equal(got.sha, sha);
    assert.equal(got.headers['content-length'], String(300 * 1024 * 1024));
    assert.equal(got.headers['x-upsert'], 'false');
    assert.equal(got.url.startsWith('/upload/33333333-3333-4333-8333-333333333333/XM10826_-_SABTECH_MERCH.af'), true);
    assert.deepEqual(db.updates.at(-1).value, { status: 'ready', storage_path: '33333333-3333-4333-8333-333333333333/XM10826_-_SABTECH_MERCH.af', error_message: null });
    assert.equal(db.removed.length, 0);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});

test('cache rejection is reported and the partial object is removed', async () => {
  const { root } = await fixture(2 * 1024 * 1024);
  const s = await server();
  try {
    const db = fakeSupabase(s.url, undefined, undefined, '/fail');
    await processFileRequest(db, root, job());
    assert.equal(db.updates.at(-1).value.status, 'error');
    assert.match(db.updates.at(-1).value.error_message, /download cache \(413\)/);
    assert.equal(db.removed.length, 1);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});

test('a file that grows mid-copy is rejected and cleaned up', async () => {
  const { root, file } = await fixture(8 * 1024 * 1024);
  let grown = false;
  const s = await server(async size => { if (!grown && size > 1024 * 1024) { grown = true; await appendFile(file, Buffer.alloc(4 * 1024 * 1024)); } });
  try {
    const db = fakeSupabase(s.url);
    await processFileRequest(db, root, job());
    assert.equal(db.updates.at(-1).value.status, 'error');
    assert.match(db.updates.at(-1).value.error_message, /changed while reading/);
    assert.equal(db.removed.length, 1);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});

test('files over 1 GB, recycle paths, links and escapes stay blocked', async () => {
  const { root, file } = await fixture(1024);
  try {
    await truncate(file, MAX_FILE_BYTES + 1); // sparse, no real disk use
    await assert.rejects(openRequestedFile(root, 'C/Customer', 'Artwork/design.af'), /larger than 1 GB/);
    await truncate(file, MAX_FILE_BYTES);
    const { handle } = await openRequestedFile(root, 'C/Customer', 'Artwork/design.af'); await handle.close();
    for (const value of ['#Recycle', '#rEcYcLe', '＃Ｒｅｃｙｃｌｅ']) {
      await assert.rejects(openRequestedFile(root, value, 'file.af'), /not accessible/);
      await assert.rejects(readRequestedFile(root, 'C/Customer', value + '/file.af'), /not accessible/);
    }
    await assert.rejects(openRequestedFile(root, 'C/Customer', '../Other/file.af'), /Invalid file path/);
    await writeFile(path.join(root, 'outside.txt'), 'x');
    await symlink(path.join(root, 'outside.txt'), path.join(root, 'C', 'Customer', 'link.txt'));
    await assert.rejects(openRequestedFile(root, 'C/Customer', 'link.txt'), /Links cannot/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('readRequestedFile still returns small files whole', async () => {
  const { root, file } = await fixture(4096);
  try { assert.deepEqual(await readRequestedFile(root, 'C/Customer', 'Artwork/design.af'), await readFile(file)); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('reads the file only as fast as the cache accepts it (no buffering)', async () => {
  const { root } = await fixture(64 * 1024 * 1024);
  let readFromDisk = 0, stalledAt = null;
  const s = await server(async size => {
    if (stalledAt === null && size > 4 * 1024 * 1024) {
      await new Promise(r => setTimeout(r, 400)); // the cache stops reading for a moment
      stalledAt = readFromDisk;
    }
  });
  try {
    const { handle, before } = await openRequestedFile(root, 'C/Customer', 'Artwork/design.af');
    const counting = { createReadStream: options => { const stream = handle.createReadStream(options); stream.on('data', c => { readFromDisk += c.length; }); return stream; } };
    try { await uploadOpenFile(fakeSupabase(s.url), 'x/file', counting, before.size, 'application/octet-stream', Date.now() + 60000); }
    finally { await handle.close(); }
    assert.equal(s.received[0].size, 64 * 1024 * 1024);
    assert.ok(stalledAt < 24 * 1024 * 1024, `read ${Math.round(stalledAt / 1048576)} MB ahead while the cache was paused`);
  } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
});
