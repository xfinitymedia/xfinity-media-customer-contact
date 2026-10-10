import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanCustomerFolders, refreshFolderCatalog } from './nas-folder-catalog.js';

test('catalog includes existing customer directories and excludes files, hidden folders, symlinks and nested order folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nas-catalog-'));
  try {
    await mkdir(path.join(root,'A','Acme','Orders'), {recursive:true});
    await mkdir(path.join(root,'#','123'), {recursive:true});
    await mkdir(path.join(root,'A','.hidden'));
    await writeFile(path.join(root,'A','file.txt'), 'x');
    await symlink(path.join(root,'A','Acme'), path.join(root,'A','alias'));
    await symlink(path.join(root,'A'),path.join(root,'B'));
    assert.deepEqual((await scanCustomerFolders(root)).map(r=>r.path).sort(), ['#/123','A/Acme']);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('failed scan does not remove the existing catalog', async () => {
  let touched = false;
  await assert.rejects(refreshFolderCatalog({from(){touched=true;}},'/nonexistent-xm-catalog-test'));
  assert.equal(touched,false);
});
