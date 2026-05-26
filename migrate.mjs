// One-shot migration: TOMI NIASHI Supabase -> INSTRUMENTS Supabase.
// Uses both projects' publishable anon keys (no service_role required —
// permissive RLS on both ends covers everything we need).
//
// Run once:  npm i @supabase/supabase-js && node migrate.mjs
//
// Idempotent: re-running upserts rows and skips storage objects that
// already exist. Safe to retry if it dies mid-way.

import { createClient } from '@supabase/supabase-js';

const OLD = createClient(
  'https://idxnrvlaqzmywmsoxdbw.supabase.co',
  'sb_publishable_s44QLf2N40pA2d811cP8CQ_4CIvUOqD'
);
const NEW = createClient(
  'https://lueovxcoqrkjdjxfvwng.supabase.co',
  'sb_publishable__lKNH5ui_nFn57fiAx2VDg_0yShDBro'
);
const BUCKET = 'tn-fragments';

async function fetchAll(client, table) {
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await client.from(table).select('*').order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch ${table}: ${error.message}`);
    if (!data.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function migrateGenomes() {
  const rows = await fetchAll(OLD, 'tn_genomes');
  if (!rows.length) { console.log('[genomes] source is empty'); return; }
  let ok = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await NEW.from('tn_genomes').upsert(batch, { onConflict: 'id' });
    if (error) { console.warn(`[genomes] batch @${i} fail:`, error.message); continue; }
    ok += batch.length;
  }
  console.log(`[genomes] migrated ${ok}/${rows.length}`);
}

async function migrateSamples() {
  const rows = await fetchAll(OLD, 'tn_samples');
  if (!rows.length) { console.log('[samples] source is empty'); return; }

  // Two-pass: insert all rows with parent_id nulled first, then update
  // parent_id afterward. tn_samples.parent_id is a self-FK so a batch
  // with mixed parents would fail on any child whose parent isn't in
  // the batch yet. Deferring is simpler than topological sort.
  const stripped = rows.map((r) => ({ ...r, parent_id: null }));
  let inserted = 0;
  for (let i = 0; i < stripped.length; i += 500) {
    const batch = stripped.slice(i, i + 500);
    const { error } = await NEW.from('tn_samples').upsert(batch, { onConflict: 'id' });
    if (error) { console.warn(`[samples] insert batch @${i} fail:`, error.message); continue; }
    inserted += batch.length;
  }
  console.log(`[samples] inserted ${inserted}/${rows.length} (parent_id deferred)`);

  const withParent = rows.filter((r) => r.parent_id);
  let linked = 0;
  for (const r of withParent) {
    const { error } = await NEW.from('tn_samples').update({ parent_id: r.parent_id }).eq('id', r.id);
    if (error) { console.warn('[samples] link fail', r.id.slice(0, 8), error.message); continue; }
    linked++;
    if (linked % 100 === 0) console.log(`[samples] linked ${linked}/${withParent.length}`);
  }
  console.log(`[samples] linked ${linked}/${withParent.length} parents`);
}

async function* walkBucket(prefix = '') {
  let offset = 0;
  while (true) {
    const { data, error } = await OLD.storage.from(BUCKET).list(prefix, {
      limit: 100, offset, sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`list ${prefix || '/'}: ${error.message}`);
    if (!data.length) break;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A folder entry has no id/metadata; a file has both.
      if (!entry.id && !entry.metadata) yield* walkBucket(path);
      else yield path;
    }
    if (data.length < 100) break;
    offset += data.length;
  }
}

async function migrateStorage() {
  let copied = 0, skipped = 0, failed = 0;
  for await (const path of walkBucket()) {
    const dl = await OLD.storage.from(BUCKET).download(path);
    if (dl.error) {
      failed++;
      // 404s from orphan rows are expected — quiet them.
      if (!/not found/i.test(dl.error.message || '')) {
        console.warn('[storage] dl fail', path, dl.error.message);
      }
      continue;
    }
    const up = await NEW.storage.from(BUCKET).upload(path, dl.data, {
      contentType: dl.data.type || 'application/octet-stream',
      upsert: false,
    });
    if (up.error) {
      if (/already exists|duplicate/i.test(up.error.message)) { skipped++; continue; }
      failed++; console.warn('[storage] up fail', path, up.error.message); continue;
    }
    copied++;
    if (copied % 25 === 0) console.log(`[storage] copied=${copied} skipped=${skipped} failed=${failed}`);
  }
  console.log(`[storage] done. copied=${copied} skipped=${skipped} failed=${failed}`);
}

console.log('--- TOMI NIASHI -> INSTRUMENTS migration ---');
await migrateGenomes();
await migrateSamples();
await migrateStorage();
console.log('--- migration finished ---');
