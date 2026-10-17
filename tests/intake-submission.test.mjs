import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Exercise the actual page's handler with controlled HTTP responses, without
// sending synthetic customers, files, or sync jobs to the production database.
const source = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const setup = source.slice(source.indexOf('const SUPABASE_URL'), source.indexOf('export default function Page'));
const handler = source.slice(source.indexOf('  async function handleSubmit'), source.indexOf('\n  return ('));

async function submit({ fields = {}, files = [], failAt = -1, rejectAt = -1 } = {}) {
  const calls = [], statuses = [], busy = [], resets = [];
  const context = vm.createContext({
    files, fileNotes: Object.fromEntries(files.map(file => [`${file.name}-${file.size}-${file.lastModified}`, ' Keep this note '])),
    crypto: { randomUUID: (() => { let id = 0; return () => `uuid-${++id}`; })() },
    FormData: class { get(key) { return ({ name: ' Test Customer ', email: ' TEST@example.invalid ', ...fields })[key]; } },
    fetch: async (url, options) => {
      const index = calls.length;
      calls.push({ url, ...options, payload: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
      if (index === rejectAt) throw new Error('Network failed');
      return { ok: index !== failAt };
    },
    setStatus: value => statuses.push(value), setSubmitting: value => busy.push(value),
    setFiles: value => resets.push(['files', value]), setFileNotes: value => resets.push(['notes', value]),
  });
  vm.runInContext(`${setup}\n${handler}\nglobalThis.submit = handleSubmit`, context);
  let reset = false;
  await context.submit({ preventDefault() {}, currentTarget: { reset() { reset = true; } } });
  return { calls, status: statuses.at(-1), busy, reset, resets };
}

test('contact without files creates exactly one pending intake before showing success', async () => {
  const result = await submit();
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[0].url, /customer_contact_submissions$/);
  assert.match(result.calls[1].url, /order_intakes$/);
  assert.equal(result.calls[1].payload.submission_id, result.calls[0].payload.id);
  assert.equal(result.calls[1].payload.customer, 'Test Customer');
  assert.equal(result.calls[1].payload.email, 'test@example.invalid');
  assert.equal(result.calls[1].payload.status, 'pending');
  assert.equal(result.status.ok, true);
  assert.equal(result.reset, true);
  assert.deepEqual(result.busy, [true, false]);
});

const file = { name: 'art work.pdf', size: 1200, type: 'application/pdf', lastModified: 10 };
test('multiple attachments retain uploads, metadata, notes and one final intake', async () => {
  const result = await submit({ files: [file, { ...file, name: 'logo.png', type: 'image/png' }] });
  assert.equal(result.calls.length, 6);
  assert.match(result.calls[1].url, /customer-uploads\/uuid-1\/uuid-2-art_work.pdf$/);
  assert.equal(result.calls[1].body, file);
  assert.equal(result.calls[1].headers['x-upsert'], 'false');
  assert.match(result.calls[2].url, /customer_uploads$/);
  assert.equal(result.calls[2].payload.notes, 'Keep this note');
  assert.equal(result.calls[2].payload.submission_id, result.calls[0].payload.id);
  assert.match(result.calls[5].url, /order_intakes$/);
  assert.equal(result.calls.filter(call => call.url.endsWith('/order_intakes')).length, 1);
  assert.equal(result.status.ok, true);
  assert.match(result.status.message, /2 files/);
});

for (const [label, options, expectedCalls] of [
  ['contact insert failure', { failAt: 0 }, 1],
  ['intake insert failure without files', { failAt: 1 }, 2],
  ['upload failure', { files: [file], failAt: 1 }, 2],
  ['metadata failure', { files: [file], failAt: 2 }, 3],
  ['intake failure after uploads', { files: [file], failAt: 3 }, 4],
  ['network failure', { rejectAt: 1 }, 2],
]) test(label + ' never displays success or clears input', async () => {
  const result = await submit(options);
  assert.equal(result.status.ok, false);
  assert.equal(result.calls.length, expectedCalls);
  assert.equal(result.reset, false);
  assert.equal(result.resets.length, 0);
  assert.equal(result.busy.at(-1), false);
});

for (const [label, options] of [
  ['missing name', { fields: { name: ' ' } }],
  ['missing contact method', { fields: { email: '', phone: '' } }],
  ['unsupported file', { files: [{ ...file, name: 'bad.exe' }] }],
  ['oversized file', { files: [{ ...file, size: 25 * 1024 * 1024 + 1 }] }],
]) test(label + ' prevents all writes', async () => {
  const result = await submit(options);
  assert.equal(result.status.ok, false);
  assert.equal(result.calls.length, 0);
});

test('phone-only submission remains supported', async () => {
  const result = await submit({ fields: { email: '', phone: '604-555-0100' } });
  assert.equal(result.status.ok, true);
  assert.equal(result.calls[1].payload.phone, '604-555-0100');
  assert.equal(result.calls[1].payload.email, null);
});
