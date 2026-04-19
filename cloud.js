// Supabase cloud persistence for genomes + samples.
// Falls back gracefully to local-only if the client can't reach the project
// or the tables don't exist yet.  Keyed by genome.id (the instrument's
// unique identity).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://idxnrvlaqzmywmsoxdbw.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_s44QLf2N40pA2d811cP8CQ_4CIvUOqD';
export const BUCKET = 'tn-fragments';

let client = null;
try {
  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
} catch (e) {
  console.warn('Supabase client init failed; continuing local-only.', e);
}
export const cloud = client;
export const cloudReady = !!client;

function log(...a) { console.log('[cloud]', ...a); }

function errText(e) {
  if (!e) return 'unknown error';
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export async function pullGenome(id) {
  if (!cloud) return null;
  const { data, error } = await cloud
    .from('tn_genomes')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) { console.error('[cloud] pullGenome error', error); throw new Error('pullGenome: ' + errText(error)); }
  return data || null;
}

export async function pushGenome(g) {
  if (!cloud) return false;
  const row = {
    id: g.id,
    seed: g.seed,
    birthday: new Date(g.birthday).toISOString(),
    params: g.params,
    generation: g.generation,
    activation_count: g.activationCount || 0,
  };
  const { error } = await cloud.from('tn_genomes').upsert(row, { onConflict: 'id' });
  if (error) { console.error('[cloud] pushGenome error', error); throw new Error('pushGenome: ' + errText(error)); }
  return true;
}

export async function pullSamples(genomeId, { includeShared = false } = {}) {
  if (!cloud) return [];
  let q = cloud.from('tn_samples').select('*');
  if (includeShared) {
    q = q.or(`genome_id.eq.${genomeId},shared.eq.true`);
  } else {
    q = q.eq('genome_id', genomeId);
  }
  const { data, error } = await q;
  if (error) { console.error('[cloud] pullSamples error', error); throw new Error('pullSamples: ' + errText(error)); }
  return data || [];
}

// Upload the blob + insert the metadata row. Throws on any Supabase error
// with a human-readable message so the caller can surface it.
export async function pushSample({ id, genome_id, blob, mime, ...meta }) {
  if (!cloud) return null;
  const baseMime = (mime || 'audio/webm').split(';')[0];
  const ext = baseMime.includes('wav') ? 'wav'
            : baseMime.includes('ogg') ? 'ogg'
            : baseMime.includes('mp4') ? 'm4a'
            : 'webm';
  const path = `${genome_id}/${id}.${ext}`;
  const up = await cloud.storage.from(BUCKET).upload(path, blob, {
    cacheControl: '3600', upsert: false, contentType: baseMime,
  });
  if (up.error) {
    console.error('[cloud] storage upload failed', { path, mime: baseMime, error: up.error });
    throw new Error('storage: ' + errText(up.error));
  }
  const row = {
    id, genome_id, storage_path: path, mime: baseMime,
    sample_rate: meta.sample_rate,
    duration_ms: meta.duration_ms,
    recorded_at: meta.recorded_at ? new Date(meta.recorded_at).toISOString() : new Date().toISOString(),
    last_played_at: meta.last_played_at ? new Date(meta.last_played_at).toISOString() : null,
    generation: meta.generation || 0,
    mutation_level: meta.mutation_level || 0,
    source: meta.source || 'mic',
    survival_score: meta.survival_score != null ? meta.survival_score : 1,
    parent_id: meta.parent_id || null,
    shared: !!meta.shared,
    detected_hz: meta.detected_hz != null ? meta.detected_hz : null,
  };
  const ins = await cloud.from('tn_samples').insert(row);
  if (ins.error) {
    console.error('[cloud] row insert failed', { id, error: ins.error });
    // The object already exists in storage — clean it up so retries don't bounce.
    cloud.storage.from(BUCKET).remove([path]).catch(() => {});
    throw new Error('insert: ' + errText(ins.error));
  }
  return path;
}

export async function updateSample(id, patch) {
  if (!cloud) return false;
  const { error } = await cloud.from('tn_samples').update(patch).eq('id', id);
  if (error) { console.error('[cloud] updateSample error', error); throw new Error('update: ' + errText(error)); }
  return true;
}

export async function deleteSample(id, storage_path) {
  if (!cloud) return false;
  if (storage_path) {
    await cloud.storage.from(BUCKET).remove([storage_path]).catch(() => {});
  }
  const { error } = await cloud.from('tn_samples').delete().eq('id', id);
  if (error) { console.error('[cloud] deleteSample error', error); throw new Error('delete: ' + errText(error)); }
  return true;
}

// Build a browser-playable URL for a sample path in our public bucket.
export function publicUrlFor(path) {
  if (!cloud) return null;
  const { data } = cloud.storage.from(BUCKET).getPublicUrl(path);
  return data ? data.publicUrl : null;
}

// Fetch a sample's audio as ArrayBuffer so we can decodeAudioData it.
export async function fetchSampleBlob(path) {
  if (!cloud) return null;
  const { data, error } = await cloud.storage.from(BUCKET).download(path);
  if (error) { log('download error', error); return null; }
  return data; // Blob
}
