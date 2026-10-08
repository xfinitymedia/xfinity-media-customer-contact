import { createClient } from '@supabase/supabase-js';
import { refreshNasIndex } from './nas-indexer.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NAS_ROOT = process.env.NAS_ROOT || '/data/Clients';
const NAS_INDEX_SECONDS = Math.max(60, Number(process.env.NAS_INDEX_SECONDS || 300));

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const worker = import('./worker.js');

async function indexLoop() {
  for (;;) {
    try {
      await refreshNasIndex(supabase, NAS_ROOT);
    } catch (error) {
      console.error('NAS index failed:', error instanceof Error ? error.message : error);
    }
    await new Promise(resolve => setTimeout(resolve, NAS_INDEX_SECONDS * 1000));
  }
}

await Promise.race([worker, indexLoop()]);
