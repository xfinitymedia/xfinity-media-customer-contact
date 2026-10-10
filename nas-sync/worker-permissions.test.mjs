import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

// Exercise the worker's filesystem functions without starting its database poller.
const source = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const directoryCode = source.slice(source.indexOf('async function ensureNasDirectory'), source.indexOf('async function resolveCustomerDirectory'));
const writeCode = source.slice(source.indexOf('async function writeBlobAtomically'), source.indexOf('async function syncUpload'));
function loadFunctions(root, overrides = {}) {
  return vm.runInNewContext(`${directoryCode}\n${writeCode}\n({ ensureNasDirectory, writeBlobAtomically })`, {
    ...fs, path, NAS_ROOT: root, Buffer, createHash, ...overrides
  });
}
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xm-permissions-'));
  const oldMask = process.umask(0o077);
  try { await run(root); } finally {
    process.umask(oldMask);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('new nested folders and uploads retain parent write access despite restrictive umask', async () => {
  await fixture(async root => {
    await fs.chmod(root, 0o777);
    const { ensureNasDirectory, writeBlobAtomically } = loadFunctions(root);
    const customer = path.join(root, 'D', 'New Customer');
    await ensureNasDirectory(customer);
    const destination = path.join(customer, 'Orders', 'SO-1', 'Artwork', 'design.txt');
    const result = await writeBlobAtomically(new Blob(['test artwork']), destination);
    for (const relative of ['D', 'D/New Customer', 'D/New Customer/Orders', 'D/New Customer/Orders/SO-1', 'D/New Customer/Orders/SO-1/Artwork']) {
      assert.equal((await fs.stat(path.join(root, relative))).mode & 0o777, 0o777);
    }
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o666);
    assert.equal(await fs.readFile(destination, 'utf8'), 'test artwork');
    assert.equal(result.size, 12);
    assert.equal(result.hash, createHash('sha256').update('test artwork').digest('hex'));
    await assert.rejects(fs.stat(`${destination}.uploading`), { code: 'ENOENT' });
  });
});

test('restricted parent access is retained and existing folders are unchanged', async () => {
  await fixture(async root => {
    await fs.chmod(root, 0o770);
    const existing = path.join(root, 'Existing');
    await fs.mkdir(existing);
    await fs.chmod(existing, 0o750);
    const { ensureNasDirectory, writeBlobAtomically } = loadFunctions(root);
    await ensureNasDirectory(existing);
    assert.equal((await fs.stat(existing)).mode & 0o777, 0o750);
    await writeBlobAtomically(new Blob(['data']), path.join(root, 'New', 'file.txt'));
    assert.equal((await fs.stat(path.join(root, 'New'))).mode & 0o777, 0o770);
    assert.equal((await fs.stat(path.join(root, 'New/file.txt'))).mode & 0o777, 0o660);
  });
});

test('new directory adopts parent numeric owner and group', async () => {
  await fixture(async root => {
    const actual = await fs.stat(root);
    const calls = [];
    const { ensureNasDirectory } = loadFunctions(root, {
      stat: async target => {
        const info = await fs.stat(target);
        if (target === root) { info.uid = actual.uid + 1; info.gid = actual.gid + 1; }
        return info;
      },
      chown: async (...args) => calls.push(args)
    });
    const directory = path.join(root, 'New');
    await ensureNasDirectory(directory);
    assert.deepEqual(calls, [[directory, actual.uid + 1, actual.gid + 1]]);
  });
});

test('permission failure removes a newly created empty directory', async () => {
  await fixture(async root => {
    const { ensureNasDirectory } = loadFunctions(root, {
      chmod: async () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); }
    });
    const directory = path.join(root, 'New');
    await assert.rejects(ensureNasDirectory(directory), { code: 'EPERM' });
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  });
});

test('file permission failure does not publish the destination', async () => {
  await fixture(async root => {
    const { writeBlobAtomically } = loadFunctions(root, {
      open: async (...args) => {
        const handle = await fs.open(...args);
        handle.chmod = async () => { throw Object.assign(new Error('Permission denied'), { code: 'EPERM' }); };
        return handle;
      }
    });
    const destination = path.join(root, 'file.txt');
    await assert.rejects(writeBlobAtomically(new Blob(['data']), destination), { code: 'EPERM' });
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  });
});

test('out of root paths and non-directory destinations are rejected', async () => {
  await fixture(async root => {
    const { ensureNasDirectory } = loadFunctions(root);
    await assert.rejects(ensureNasDirectory(path.join(root, '..', 'outside')), /outside NAS_ROOT/);
    await fs.writeFile(path.join(root, 'file'), 'data');
    await assert.rejects(ensureNasDirectory(path.join(root, 'file')), /not a directory/);
  });
});
