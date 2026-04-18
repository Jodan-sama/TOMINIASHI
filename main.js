// TOMI NIASHI — breathing synthesizer simulator
// Sections: prng, genome, store, audio, recorder, voice, evolver, scheduler, input, viz, ui, boot

const DB_NAME = 'tominiashi_synth';
const DB_STORE = 'samples';
const LS_GENOME = 'tn_genome_v1';

const state = {
  ctx: null, master: null, revSend: null, delSend: null, analyser: null, analyserData: null,
  perfFilter: null, perfGain: null, ambGain: null, eventGain: null,
  filterLFO: null, filterLFOGain: null,
  genome: null, store: null, samples: [],
  prng: Math.random,
  mood: 'chatter', intensity: 0.5, excitement: 0, lastEvolveAt: 0,
  scaleIndex: 0, scaleRoot: 0, melodyStep: 0,
  mouse: { x: 0.5, y: 0.5, down: false, lastMoveAt: 0 },
  started: false, recording: false,
  bufferCache: new Map(),
  lastGrainAt: 0,
};

// ======== PRNG ========
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// ======== GENOME ========
function newGenome() {
  const id = (crypto.randomUUID ? crypto.randomUUID() : 'g-' + Math.random().toString(36).slice(2));
  const seed = (Math.random() * 4294967296) >>> 0;
  const r = mulberry32(seed);
  return {
    id, seed, birthday: Date.now(),
    params: {
      grainMinMs: 40 + r() * 80,
      grainMaxMs: 150 + r() * 350,
      pitchDrift: 0.02 + r() * 0.25,
      chopProbability: 0.3 + r() * 0.5,
      wakeMeanSeconds: 20 + r() * 90,
      reverbAmount: 0.15 + r() * 0.45,
      degradationRate: 0.006 + r() * 0.025,
      melodicBias: r(),
    },
    generation: 0,
    activationCount: 0,
  };
}
function loadGenome() {
  try {
    const raw = localStorage.getItem(LS_GENOME);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const g = newGenome();
  localStorage.setItem(LS_GENOME, JSON.stringify(g));
  return g;
}
function saveGenome() {
  try { localStorage.setItem(LS_GENOME, JSON.stringify(state.genome)); } catch (e) {}
}
// ======== STORE (IndexedDB) ========
function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = (mode) => db.transaction(DB_STORE, mode).objectStore(DB_STORE);
      resolve({
        add: (rec) => new Promise((res, rej) => { const r = tx('readwrite').put(rec); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }),
        get: (id) => new Promise((res, rej) => { const r = tx('readonly').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
        all: () => new Promise((res, rej) => { const r = tx('readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
        update: async (id, patch) => {
          const cur = await new Promise((res, rej) => { const r = tx('readonly').get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          if (!cur) return;
          Object.assign(cur, patch);
          return new Promise((res, rej) => { const r = tx('readwrite').put(cur); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
        },
        del: (id) => new Promise((res, rej) => { const r = tx('readwrite').delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }),
        clear: () => new Promise((res, rej) => { const r = tx('readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }),
      });
    };
    req.onerror = () => reject(req.error);
  });
}
function sampleMeta(s) {
  return {
    id: s.id, sampleRate: s.sampleRate, recordedAt: s.recordedAt,
    lastPlayedAt: s.lastPlayedAt || 0, generation: s.generation,
    mutationLevel: s.mutationLevel || 0, source: s.source,
    survivalScore: s.survivalScore == null ? 1 : s.survivalScore,
    parentId: s.parentId || null,
    durationMs: (s.pcm.length / s.sampleRate) * 1000,
  };
}
// ======== AUDIO ========
function makeIR(ctx, dur, decay) {
  const len = Math.floor(ctx.sampleRate * dur);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}
async function initAudio() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctor();
  if (ctx.state === 'suspended') await ctx.resume();
  const master = ctx.createGain();
  master.gain.value = 0.7;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  // reverb
  const convolver = ctx.createConvolver();
  convolver.buffer = makeIR(ctx, 3.0, 2.6);
  const revSend = ctx.createGain();
  revSend.gain.value = state.genome.params.reverbAmount;
  // delay with feedback
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = 0.34;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.42;
  delay.connect(feedback);
  feedback.connect(delay);
  const delSend = ctx.createGain();
  delSend.gain.value = 0.2;
  // Performance bus — melodic/user grains pass through a state-variable filter
  const perfFilter = ctx.createBiquadFilter();
  perfFilter.type = 'lowpass';
  perfFilter.frequency.value = 3200;
  perfFilter.Q.value = 1.5;
  const perfGain = ctx.createGain();
  perfGain.gain.value = 0.85;
  perfGain.connect(perfFilter);
  perfFilter.connect(master);
  // Ambient bus — drones, long reverb tail, always very filtered
  const ambFilter = ctx.createBiquadFilter();
  ambFilter.type = 'lowpass';
  ambFilter.frequency.value = 1100;
  ambFilter.Q.value = 0.7;
  const ambGain = ctx.createGain();
  ambGain.gain.value = 0.45;
  ambGain.connect(ambFilter);
  ambFilter.connect(master);
  // Event bus — peaks, arpeggios; slight bandpass sheen
  const eventGain = ctx.createGain();
  eventGain.gain.value = 0.9;
  eventGain.connect(master);
  // Filter LFO — modulates the perf filter cutoff so things breathe
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.15;
  lfoGain.gain.value = 900;
  lfo.connect(lfoGain);
  lfoGain.connect(perfFilter.frequency);
  lfo.start();
  // routing out
  master.connect(analyser);
  analyser.connect(ctx.destination);
  revSend.connect(convolver);
  convolver.connect(master);
  delSend.connect(delay);
  delay.connect(master);
  // ambient feeds reverb heavily
  const ambRev = ctx.createGain();
  ambRev.gain.value = 0.65;
  ambFilter.connect(ambRev);
  ambRev.connect(convolver);
  state.ctx = ctx;
  state.master = master;
  state.analyser = analyser;
  state.revSend = revSend;
  state.delSend = delSend;
  state.perfFilter = perfFilter;
  state.perfGain = perfGain;
  state.ambGain = ambGain;
  state.eventGain = eventGain;
  state.ambFilter = ambFilter;
  state.filterLFO = lfo;
  state.filterLFOGain = lfoGain;
  state.analyserData = new Uint8Array(analyser.frequencyBinCount);
}
// ======== SCALES / NOTES ========
const SCALES = [
  { name: 'minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'major pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'hirajoshi', steps: [0, 2, 3, 7, 8] },
  { name: 'whole-tone', steps: [0, 2, 4, 6, 8, 10] },
];
function scaleNow() { return SCALES[state.scaleIndex % SCALES.length]; }
function degreeToSemitones(degree) {
  const sc = scaleNow();
  const len = sc.steps.length;
  const octave = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return sc.steps[idx] + octave * 12 + state.scaleRoot;
}
function rateForSemitones(st) { return Math.pow(2, st / 12); }
function rateForDegree(degree) { return rateForSemitones(degreeToSemitones(degree)); }
// ======== RECORDER ========
let micStream = null;
async function ensureMic() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  return micStream;
}
async function recordBreath(durMs = 3000) {
  if (state.recording) return null;
  state.recording = true;
  try {
    await ensureMic();
    const rec = new MediaRecorder(micStream);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    await new Promise((r) => setTimeout(r, durMs));
    rec.stop();
    await done;
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
    const ab = await blob.arrayBuffer();
    const audioBuf = await state.ctx.decodeAudioData(ab);
    const pcm = audioBuf.getChannelData(0).slice();
    const record = {
      id: crypto.randomUUID(),
      pcm, sampleRate: audioBuf.sampleRate,
      recordedAt: Date.now(), lastPlayedAt: 0,
      generation: state.genome.generation,
      mutationLevel: 0, source: 'mic', survivalScore: 1,
      parentId: null,
    };
    await state.store.add(record);
    state.samples.push(sampleMeta(record));
    return record;
  } finally {
    state.recording = false;
  }
}
// ======== VOICE / CHOPPER ========
function toAudioBuffer(rec) {
  const cached = state.bufferCache.get(rec.id);
  if (cached) return cached;
  const buf = state.ctx.createBuffer(1, rec.pcm.length, rec.sampleRate);
  buf.copyToChannel(rec.pcm, 0);
  state.bufferCache.set(rec.id, buf);
  if (state.bufferCache.size > 48) {
    const first = state.bufferCache.keys().next().value;
    state.bufferCache.delete(first);
  }
  return buf;
}
function triggerGrain(rec, opts) {
  const ctx = state.ctx;
  const {
    offsetMs, durationMs, rate, pan, gain, mutation,
    layer = 'perf',        // 'perf' | 'ambient' | 'event'
    filterType = null,     // override, else per-layer default
    filterHz = null,       // override cutoff
    filterQ = null,
    revSend: revAmount = null,
    delSend: delAmount = null,
    detuneCents = 0,
  } = opts;
  const buf = toAudioBuffer(rec);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  if (detuneCents) { try { src.detune.value = detuneCents; } catch (e) {} }
  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  const dur = Math.max(0.02, durationMs / 1000);
  const atk = Math.min(0.04, dur * (layer === 'ambient' ? 0.5 : 0.3));
  const rel = Math.min(0.15, dur * (layer === 'ambient' ? 0.5 : 0.4));
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + atk);
  env.gain.setValueAtTime(gain, t0 + Math.max(atk, dur - rel));
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  let tail = env;
  // Per-grain color filter
  const wantFilter = filterType || (mutation > 0.2 || layer === 'ambient' || Math.random() < 0.5);
  if (wantFilter) {
    const bq = ctx.createBiquadFilter();
    if (filterType) bq.type = filterType;
    else bq.type = mutation > 0.3 ? 'lowpass' : (Math.random() < 0.2 ? 'bandpass' : 'lowpass');
    let freq = filterHz;
    if (freq == null) {
      if (layer === 'ambient') freq = 600 + Math.random() * 1200;
      else freq = Math.max(500, 16000 * (1 - mutation * 0.85) * (0.5 + state.mouse.x));
    }
    bq.frequency.value = freq;
    bq.Q.value = filterQ != null ? filterQ : (bq.type === 'bandpass' ? 2.5 : 0.7);
    env.connect(bq);
    tail = bq;
  }
  // Bitcrush / waveshaper for heavy mutation
  if (mutation > 0.55 && Math.random() < 0.7) {
    const ws = ctx.createWaveShaper();
    const bits = Math.max(2, Math.floor(8 - mutation * 6));
    const steps = Math.pow(2, bits);
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1024) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    ws.curve = curve;
    tail.connect(ws);
    tail = ws;
  }
  src.connect(env);
  tail.connect(panner);
  // Route to bus
  const bus = layer === 'ambient' ? state.ambGain
            : layer === 'event'   ? state.eventGain
            : state.perfGain;
  panner.connect(bus || state.master);
  // Reverb / delay sends per-layer
  const rev = revAmount != null ? revAmount
    : layer === 'ambient' ? 0.9
    : layer === 'event'   ? 0.5
    : 0.35 + (1 - state.mouse.y) * 0.5;
  const del = delAmount != null ? delAmount
    : layer === 'ambient' ? 0.15
    : layer === 'event'   ? 0.35
    : (Math.random() < 0.5 ? 0.25 : 0);
  if (rev > 0.01 && state.revSend) {
    const rg = ctx.createGain(); rg.gain.value = rev;
    panner.connect(rg); rg.connect(state.revSend);
    src.addEventListener('ended', () => { try { rg.disconnect(); } catch (e) {} });
  }
  if (del > 0.01 && state.delSend) {
    const dg = ctx.createGain(); dg.gain.value = del;
    panner.connect(dg); dg.connect(state.delSend);
    src.addEventListener('ended', () => { try { dg.disconnect(); } catch (e) {} });
  }
  try { src.start(t0, Math.max(0, offsetMs / 1000), dur * 1.1); } catch (e) {}
  src.stop(t0 + dur + 0.12);
  src.onended = () => { try { src.disconnect(); env.disconnect(); panner.disconnect(); } catch (e) {} };
  state.lastGrainAt = Date.now();
}
// ======== EVOLVER ========
function drift(key, amount, lo, hi) {
  const v = state.genome.params[key] + (state.prng() * 2 - 1) * amount;
  state.genome.params[key] = Math.max(lo, Math.min(hi, v));
}
async function deriveSample(parentMeta) {
  const full = await state.store.get(parentMeta.id);
  if (!full) return;
  const src = full.pcm;
  const sr = full.sampleRate;
  const startS = Math.floor(state.prng() * src.length * 0.7);
  const lenS = Math.floor(sr * (0.08 + state.prng() * 0.6));
  const end = Math.min(src.length, startS + lenS);
  let child = src.slice(startS, end);
  if (state.prng() < 0.3) child = child.slice().reverse();
  if (state.prng() < 0.4) {
    const gain = 0.6 + state.prng() * 0.5;
    for (let i = 0; i < child.length; i++) child[i] *= gain;
  }
  const rec = {
    id: crypto.randomUUID(),
    pcm: child, sampleRate: sr,
    recordedAt: Date.now(), lastPlayedAt: 0,
    generation: state.genome.generation,
    mutationLevel: Math.min(0.7, (parentMeta.mutationLevel || 0) + 0.1),
    source: 'derived', survivalScore: 0.8,
    parentId: parentMeta.id,
  };
  await state.store.add(rec);
  state.samples.push(sampleMeta(rec));
}
async function evolveTick() {
  const params = state.genome.params;
  for (const meta of state.samples) {
    meta.mutationLevel = Math.min(1, meta.mutationLevel + params.degradationRate * (0.5 + state.prng()));
    if (state.prng() < 0.06) meta.survivalScore *= 0.88;
    try { await state.store.update(meta.id, { mutationLevel: meta.mutationLevel, survivalScore: meta.survivalScore }); } catch (e) {}
  }
  const fresh = state.samples.filter((s) => s.mutationLevel < 0.35 && s.source !== 'derived');
  if (fresh.length && state.prng() < 0.45) {
    const parent = fresh[Math.floor(state.prng() * fresh.length)];
    await deriveSample(parent);
  }
  // cull samples that have withered below threshold
  const dead = state.samples.filter((s) => s.survivalScore < 0.05);
  for (const s of dead) {
    try { await state.store.del(s.id); } catch (e) {}
  }
  state.samples = state.samples.filter((s) => s.survivalScore >= 0.05);
  drift('pitchDrift', 0.01, 0, 1);
  drift('chopProbability', 0.03, 0.1, 0.95);
  drift('wakeMeanSeconds', 5, 10, 180);
  drift('reverbAmount', 0.02, 0, 0.8);
  drift('degradationRate', 0.001, 0.002, 0.05);
  drift('melodicBias', 0.02, 0, 1);
  drift('grainMinMs', 3, 20, 160);
  drift('grainMaxMs', 8, 120, 800);
  if (state.revSend) state.revSend.gain.value = state.genome.params.reverbAmount;
  state.genome.generation++;
  state.lastEvolveAt = Date.now();
  saveGenome();
}
// ======== SCHEDULER (always-on, three layers) ========
// Ambient layer: slow, droning, heavily reverbed, long grains, always plays.
// Performance layer: melodic grains quantized to a scale; density follows mouse/mood.
// Event layer: occasional excited bursts — arpeggios, rapid ascents, rare silences.
function pickMoodEvery(ms = 18000) {
  const now = Date.now();
  if (!state._lastMoodPick || now - state._lastMoodPick > ms) {
    state._lastMoodPick = now;
    const moods = ['hush', 'chatter', 'memory', 'new'];
    const r = state.prng();
    state.mood = r < 0.3 ? 'hush' : r < 0.65 ? 'chatter' : r < 0.85 ? 'memory' : 'new';
    document.body.className = 'awake mood-' + state.mood;
    // pick a new scale occasionally
    if (state.prng() < 0.35) state.scaleIndex = Math.floor(state.prng() * SCALES.length);
    // pick a new root occasionally
    if (state.prng() < 0.35) state.scaleRoot = Math.floor(state.prng() * 12) - 5;
    // intensity baseline per mood
    state.intensity = state.mood === 'hush' ? 0.25
                    : state.mood === 'chatter' ? 0.65
                    : state.mood === 'memory' ? 0.4
                    : 0.75;
  }
}
function pickSamplesForMood(mood) {
  const now = Date.now();
  const out = state.samples.filter((s) => {
    const ageMs = now - s.recordedAt;
    if (mood === 'memory') return ageMs > 60 * 1000 || s.mutationLevel > 0.35;
    if (mood === 'new') return ageMs < 90 * 1000 || s.source === 'mic';
    if (mood === 'hush') return s.mutationLevel < 0.7;
    return true;
  });
  return out.length ? out : state.samples;
}
function pickSample(pool) {
  if (!pool || !pool.length) return null;
  return pool[Math.floor(state.prng() * pool.length)];
}

// --- Ambient: long, low, reverbed drone-grains ---
async function ambientTick() {
  if (!state.started || !state.samples.length) { setTimeout(ambientTick, 1500); return; }
  const pool = pickSamplesForMood(state.mood === 'hush' ? 'memory' : state.mood);
  const meta = pickSample(pool);
  if (meta) {
    const full = await state.store.get(meta.id).catch(() => null);
    if (full) {
      const dur = 800 + state.prng() * 2400;
      const maxOff = Math.max(0, meta.durationMs - dur);
      const offsetMs = state.prng() * maxOff;
      // ambient uses octave-down or fifth for drone feel
      const choices = [-12, -7, -5, 0, 7];
      const st = choices[Math.floor(state.prng() * choices.length)];
      const rate = rateForSemitones(st + (state.prng() * 2 - 1) * 2);
      const pan = (state.prng() * 2 - 1) * 0.85;
      const gain = 0.18 + state.prng() * 0.14;
      const filterHz = 500 + state.prng() * 900 + (1 - state.mouse.y) * 600;
      triggerGrain(full, {
        offsetMs, durationMs: dur, rate: Math.max(0.15, Math.min(2, rate)),
        pan, gain, mutation: Math.max(meta.mutationLevel, 0.3),
        layer: 'ambient', filterType: 'lowpass', filterHz, filterQ: 0.5,
        revSend: 0.9, delSend: 0.2,
      });
    }
  }
  const next = 600 + state.prng() * 1200 * (1.6 - state.intensity);
  setTimeout(ambientTick, next);
}

// --- Performance/melody: pitched grains walking a scale ---
function stepMelody() {
  const bias = state.genome.params.melodicBias;
  // high bias → smoother stepwise walk; low bias → leaps
  let jump;
  if (state.prng() < bias) jump = (state.prng() < 0.5 ? -1 : 1);
  else jump = Math.floor((state.prng() * 2 - 1) * 4);
  state.melodyStep += jump;
  // wrap
  if (state.melodyStep > 14) state.melodyStep = 8 + Math.floor(state.prng() * 4);
  if (state.melodyStep < -10) state.melodyStep = -4 - Math.floor(state.prng() * 4);
  return state.melodyStep;
}
async function performanceTick() {
  if (!state.started || !state.samples.length) { setTimeout(performanceTick, 800); return; }
  pickMoodEvery();
  const pool = pickSamplesForMood(state.mood);
  const meta = pickSample(pool);
  if (meta) {
    const full = await state.store.get(meta.id).catch(() => null);
    if (full) {
      const p = state.genome.params;
      const grainMs = p.grainMinMs + state.prng() * Math.max(20, p.grainMaxMs - p.grainMinMs);
      const durMs = Math.min(grainMs, Math.max(30, meta.durationMs - 20));
      const maxOffset = Math.max(0, meta.durationMs - durMs);
      const offsetMs = state.prng() * maxOffset;
      const degree = stepMelody();
      // mouse X transposes degree ±5
      const transposedDegree = degree + Math.round((state.mouse.x - 0.5) * 10);
      const rate = rateForDegree(transposedDegree) * (1 + (state.prng() * 2 - 1) * p.pitchDrift * 0.1);
      const pan = Math.sin(state.melodyStep * 0.8) * 0.6 + (state.prng() * 2 - 1) * 0.25;
      const yGain = 0.28 + (1 - state.mouse.y) * 0.45;
      const gain = (0.5 + state.prng() * 0.25) * yGain;
      // filter cutoff tied to mouse Y (1 = low, 0 = open)
      const cutoff = 400 + (1 - state.mouse.y) * 9000 + state.prng() * 1200;
      triggerGrain(full, {
        offsetMs, durationMs: durMs,
        rate: Math.max(0.2, Math.min(4, rate)),
        pan, gain, mutation: meta.mutationLevel,
        layer: 'perf', filterHz: cutoff,
        detuneCents: (state.prng() * 2 - 1) * 12,
      });
      meta.lastPlayedAt = Date.now();
    }
  }
  // tempo: mood + mouse Y + intensity; low Y = busier
  const base = state.mood === 'hush' ? 520
            : state.mood === 'chatter' ? 140
            : state.mood === 'memory' ? 320
            : 180;
  const mouseSpeed = 1.5 - state.mouse.y; // Y 0 (top) = faster
  const next = Math.max(45, base / mouseSpeed * (0.7 + state.prng() * 0.6));
  setTimeout(performanceTick, next);
}

// --- Events: arpeggios, bursts, silences ---
function scheduleNextEvent() {
  const base = 8000 + state.prng() * 20000;
  const scaled = base / (0.4 + state.intensity);
  setTimeout(runEvent, scaled);
}
async function runEvent() {
  if (!state.started || !state.samples.length) { scheduleNextEvent(); return; }
  const kind = (() => {
    const r = state.prng();
    if (r < 0.35) return 'arpeggio';
    if (r < 0.55) return 'burst';
    if (r < 0.7)  return 'ascent';
    if (r < 0.82) return 'drop';
    if (r < 0.92) return 'silence';
    return 'echo';
  })();
  state.excitement = 1;
  const pool = pickSamplesForMood(state.mood);
  const meta = pickSample(pool);
  if (!meta) { scheduleNextEvent(); return; }
  const full = await state.store.get(meta.id).catch(() => null);
  if (!full) { scheduleNextEvent(); return; }
  const p = state.genome.params;

  if (kind === 'arpeggio') {
    const root = Math.floor(state.prng() * 5);
    const pattern = [0, 2, 4, 7, 4, 2];
    const stepMs = 90 + state.prng() * 140;
    for (let i = 0; i < pattern.length * 2; i++) {
      const d = root + pattern[i % pattern.length] + (i >= pattern.length ? 7 : 0);
      setTimeout(() => {
        triggerGrain(full, {
          offsetMs: state.prng() * Math.max(0, meta.durationMs - 200),
          durationMs: 100 + state.prng() * 120,
          rate: rateForDegree(d),
          pan: (state.prng() * 2 - 1) * 0.7,
          gain: 0.55,
          mutation: meta.mutationLevel * 0.5,
          layer: 'event', filterType: 'bandpass', filterHz: 1200 + d * 120, filterQ: 3,
          revSend: 0.4, delSend: 0.4,
        });
      }, i * stepMs);
    }
  } else if (kind === 'burst') {
    for (let i = 0; i < 8 + Math.floor(state.prng() * 10); i++) {
      setTimeout(() => {
        triggerGrain(full, {
          offsetMs: state.prng() * Math.max(0, meta.durationMs - 80),
          durationMs: 40 + state.prng() * 100,
          rate: rateForDegree(Math.floor(state.prng() * 14) - 3),
          pan: (state.prng() * 2 - 1) * 0.95,
          gain: 0.35 + state.prng() * 0.25,
          mutation: meta.mutationLevel,
          layer: 'event', filterHz: 1500 + state.prng() * 6000,
          revSend: 0.6, delSend: 0.5,
        });
      }, i * (25 + state.prng() * 50));
    }
  } else if (kind === 'ascent') {
    for (let i = 0; i < 10; i++) {
      setTimeout(() => {
        triggerGrain(full, {
          offsetMs: state.prng() * Math.max(0, meta.durationMs - 120),
          durationMs: 140,
          rate: rateForDegree(i - 3),
          pan: (i / 10) * 1.6 - 0.8,
          gain: 0.45,
          mutation: meta.mutationLevel * 0.4,
          layer: 'event', filterType: 'bandpass', filterHz: 500 + i * 700, filterQ: 4,
          revSend: 0.5, delSend: 0.3,
        });
      }, i * (80 + state.prng() * 60));
    }
  } else if (kind === 'drop') {
    for (let i = 0; i < 8; i++) {
      setTimeout(() => {
        triggerGrain(full, {
          offsetMs: state.prng() * Math.max(0, meta.durationMs - 200),
          durationMs: 220 + i * 30,
          rate: rateForDegree(6 - i),
          pan: (state.prng() * 2 - 1) * 0.5,
          gain: 0.55 - i * 0.03,
          mutation: Math.min(1, meta.mutationLevel + i * 0.05),
          layer: 'event', filterType: 'lowpass', filterHz: 4000 - i * 380, filterQ: 2,
          revSend: 0.7, delSend: 0.5,
        });
      }, i * 130);
    }
  } else if (kind === 'echo') {
    // play one loud grain with heavy delay send repeatedly
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        triggerGrain(full, {
          offsetMs: state.prng() * Math.max(0, meta.durationMs - 180),
          durationMs: 200 + state.prng() * 200,
          rate: rateForDegree(stepMelody()),
          pan: (state.prng() * 2 - 1) * 0.6,
          gain: 0.55 - i * 0.1,
          mutation: meta.mutationLevel,
          layer: 'event', filterHz: 1800 + state.prng() * 2000,
          revSend: 0.3, delSend: 0.95,
        });
      }, i * 260);
    }
  } // silence kind: just don't trigger, intensity briefly dips
  else if (kind === 'silence') {
    const prev = state.intensity;
    state.intensity = 0.05;
    setTimeout(() => { state.intensity = prev; }, 2500 + state.prng() * 3500);
  }
  setTimeout(() => { state.excitement = Math.max(0, state.excitement - 0.15); }, 2000);
  scheduleNextEvent();
}

async function autoRecord() {
  if (state.recording) return;
  if (state.samples.length >= 40) return;
  if (!micStream) return;
  await recordBreath(2000 + state.prng() * 2000);
}

// triggered by the "excite" button: force a big event right now
function excite() {
  state.excitement = 1;
  runEvent();
}
// ======== INPUT (mouse) ========
function initInput() {
  const cv = document.getElementById('viz');
  const onMove = (cx, cy) => {
    state.mouse.x = cx / window.innerWidth;
    state.mouse.y = cy / window.innerHeight;
    state.mouse.lastMoveAt = Date.now();
  };
  cv.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
  cv.addEventListener('mousedown', () => {
    state.mouse.down = true;
    if (!state.started) return;
    playerBurst();
  });
  cv.addEventListener('mouseup', () => { state.mouse.down = false; });
  cv.addEventListener('mouseleave', () => { state.mouse.down = false; });
  cv.addEventListener('touchstart', (e) => {
    if (e.touches.length) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
      state.mouse.down = true;
      playerBurst();
    }
  }, { passive: true });
  cv.addEventListener('touchmove', (e) => {
    if (e.touches.length) onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  cv.addEventListener('touchend', () => { state.mouse.down = false; });
  // hold-to-play burst loop (small, since performanceTick already runs)
  setInterval(() => {
    if (state.mouse.down && state.started && state.samples.length) playerBurst();
  }, 120);
  // continuously drive the perf filter cutoff from mouse Y + LFO
  const driveFilter = () => {
    if (state.perfFilter && state.ctx) {
      const base = 320 + (1 - state.mouse.y) * 6800;
      const target = base * (0.8 + state.excitement * 0.6);
      try {
        state.perfFilter.frequency.setTargetAtTime(target, state.ctx.currentTime, 0.08);
        state.perfFilter.Q.setTargetAtTime(1 + state.mouse.y * 4, state.ctx.currentTime, 0.1);
      } catch (e) {}
    }
    if (state.ambFilter && state.ctx) {
      const amb = 400 + (1 - state.mouse.y) * 1400;
      try { state.ambFilter.frequency.setTargetAtTime(amb, state.ctx.currentTime, 0.2); } catch (e) {}
    }
    requestAnimationFrame(driveFilter);
  };
  requestAnimationFrame(driveFilter);
}
async function playerBurst() {
  if (!state.samples.length) return;
  const pool = state.samples;
  const meta = pool[Math.floor(state.prng() * pool.length)];
  const full = await state.store.get(meta.id).catch(() => null);
  if (!full) return;
  const count = 1 + Math.floor((1 - state.mouse.y) * 5);
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const degree = stepMelody() + Math.round((state.mouse.x - 0.5) * 10);
      const durMs = 80 + state.prng() * 160;
      const offsetMs = state.prng() * Math.max(0, meta.durationMs - durMs);
      triggerGrain(full, {
        offsetMs, durationMs: durMs,
        rate: rateForDegree(degree),
        pan: (state.prng() * 2 - 1) * 0.8,
        gain: 0.6 + state.prng() * 0.2,
        mutation: meta.mutationLevel * 0.5,
        layer: 'perf', filterHz: 600 + (1 - state.mouse.y) * 8000, filterQ: 2,
        revSend: 0.4, delSend: 0.3,
      });
    }, i * (20 + state.prng() * 50));
  }
}
// ======== VISUALIZER ========
const viz = { cv: null, ctx: null, w: 0, h: 0, dpr: 1, phase: 0, ring: new Array(96).fill(0) };
function resizeViz() {
  viz.dpr = Math.min(2, window.devicePixelRatio || 1);
  viz.w = window.innerWidth;
  viz.h = window.innerHeight;
  viz.cv.width = viz.w * viz.dpr;
  viz.cv.height = viz.h * viz.dpr;
  viz.cv.style.width = viz.w + 'px';
  viz.cv.style.height = viz.h + 'px';
  viz.ctx.setTransform(viz.dpr, 0, 0, viz.dpr, 0, 0);
}
function moodColor() {
  switch (state.mood) {
    case 'chatter': return '#ff8a2a';
    case 'memory': return '#a06aa0';
    case 'new': return '#e8c66e';
    default: return '#3c5a6e';
  }
}
function drawViz(dt) {
  const c = viz.ctx;
  const w = viz.w, h = viz.h;
  c.fillStyle = 'rgba(10, 9, 7, 0.18)';
  c.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const baseR = Math.min(w, h) * 0.18;
  // read analyser
  let level = 0;
  if (state.analyser && state.analyserData) {
    state.analyser.getByteFrequencyData(state.analyserData);
    let sum = 0;
    for (let i = 0; i < state.analyserData.length; i++) sum += state.analyserData[i];
    level = sum / (state.analyserData.length * 255);
  }
  // breathe
  viz.phase += dt * (0.6 + state.intensity * 1.2 + state.excitement * 0.8);
  const breath = 0.5 + Math.sin(viz.phase) * 0.5;
  const r = baseR * (0.85 + breath * 0.2 + level * 0.6);
  // mouse parallax
  const mx = (state.mouse.x - 0.5) * 40;
  const my = (state.mouse.y - 0.5) * 40;
  // concentric rings
  const col = moodColor();
  c.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const rr = r * (0.5 + i * 0.14) + level * 20 * i;
    c.strokeStyle = col + Math.floor(30 - i * 3).toString(16).padStart(2, '0');
    c.beginPath();
    c.arc(cx + mx * (1 - i / 12), cy + my * (1 - i / 12), rr, 0, Math.PI * 2);
    c.stroke();
  }
  // inner glowing disc
  const grad = c.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, col + 'aa');
  grad.addColorStop(0.6, col + '22');
  grad.addColorStop(1, col + '00');
  c.fillStyle = grad;
  c.beginPath();
  c.arc(cx, cy, r, 0, Math.PI * 2);
  c.fill();
  // spectrum petals
  if (state.analyser && state.analyserData) {
    const bins = 96;
    const step = Math.floor(state.analyserData.length / bins);
    c.strokeStyle = col + 'cc';
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i < bins; i++) {
      const v = state.analyserData[i * step] / 255;
      viz.ring[i] = viz.ring[i] * 0.82 + v * 0.18;
      const a = (i / bins) * Math.PI * 2 - Math.PI / 2;
      const rr = r + 6 + viz.ring[i] * 80;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.stroke();
  }
  // samples as orbiting dots
  const now = Date.now();
  for (let i = 0; i < state.samples.length; i++) {
    const s = state.samples[i];
    const age = (now - s.recordedAt) / 1000;
    const orbit = baseR * 1.6 + (i % 5) * 18;
    const speed = 0.08 + (s.source === 'derived' ? 0.05 : 0.02);
    const a = viz.phase * speed + i * 0.7;
    const dx = cx + Math.cos(a) * orbit;
    const dy = cy + Math.sin(a) * orbit * 0.55;
    const dotR = 3 + s.survivalScore * 3;
    const fadedColor = s.mutationLevel > 0.5 ? '#8a7f6c' : col;
    c.fillStyle = fadedColor + 'cc';
    c.beginPath();
    c.arc(dx, dy, dotR, 0, Math.PI * 2);
    c.fill();
    if (s.lastPlayedAt && now - s.lastPlayedAt < 400) {
      c.strokeStyle = col;
      c.lineWidth = 1;
      c.beginPath();
      c.arc(dx, dy, dotR + (now - s.lastPlayedAt) * 0.08, 0, Math.PI * 2);
      c.stroke();
    }
    if (age < 3) {
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(dx, dy, 1.5, 0, Math.PI * 2);
      c.fill();
    }
  }
}
// ======== UI ========
const el = (id) => document.getElementById(id);
function fmtTime(ms) {
  if (ms < 1000) return Math.floor(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = s / 60;
  if (m < 60) return m.toFixed(1) + 'm';
  return (m / 60).toFixed(1) + 'h';
}
function fmtClock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function updateReadouts() {
  const g = state.genome;
  el('clock').textContent = fmtClock();
  el('r-genome').textContent = g.id.slice(0, 8);
  el('r-gen').textContent = g.generation;
  el('r-mood').textContent = state.mood;
  el('r-state').textContent = 'playing · ' + (scaleNow().name);
  el('r-samples').textContent = state.samples.length;
  el('r-wakes').textContent = g.activationCount;
  el('r-age').textContent = fmtTime(Date.now() - g.birthday);
  const now = Date.now();
  let oldest = 0;
  for (const s of state.samples) { const a = now - s.recordedAt; if (a > oldest) oldest = a; }
  el('r-oldest').textContent = state.samples.length ? fmtTime(oldest) : '—';
  el('r-nextwake').textContent = 'intensity ' + state.intensity.toFixed(2);
  const p = g.params;
  el('p-grain').textContent = p.grainMinMs.toFixed(0) + '–' + p.grainMaxMs.toFixed(0);
  el('p-pitch').textContent = p.pitchDrift.toFixed(3);
  el('p-chop').textContent = p.chopProbability.toFixed(2);
  el('p-wake').textContent = p.wakeMeanSeconds.toFixed(0) + 's';
  el('p-rev').textContent = p.reverbAmount.toFixed(2);
  el('p-dec').textContent = p.degradationRate.toFixed(4);
  el('p-mel').textContent = p.melodicBias.toFixed(2);
}
function wireControls() {
  el('btn-record').addEventListener('click', async () => {
    const btn = el('btn-record');
    btn.classList.add('recording');
    btn.textContent = '◉ recording…';
    try { await recordBreath(3000); } catch (e) { console.error(e); }
    btn.classList.remove('recording');
    btn.textContent = '◉ record breath';
  });
  // repurposed: excite = force an event; chill = drop intensity
  const wakeBtn = el('btn-wake'); if (wakeBtn) { wakeBtn.textContent = '✦ excite'; wakeBtn.addEventListener('click', () => excite()); }
  const sleepBtn = el('btn-sleep'); if (sleepBtn) {
    sleepBtn.textContent = '~ chill';
    sleepBtn.addEventListener('click', () => {
      state.mood = 'hush'; state.intensity = 0.15; state.excitement = 0;
      document.body.className = 'awake mood-hush';
    });
  }
  el('btn-evolve').addEventListener('click', () => evolveTick());
  el('btn-wipe').addEventListener('click', async () => {
    if (!confirm('Wipe this instrument? Genome + all samples erased.')) return;
    try { await state.store.clear(); } catch (e) {}
    localStorage.removeItem(LS_GENOME);
    location.reload();
  });
  el('vol').addEventListener('input', (e) => {
    if (state.master) state.master.gain.value = parseFloat(e.target.value);
  });
}
// ======== BOOT ========
let lastFrame = 0;
function loop(t) {
  const dt = Math.min(0.1, (t - lastFrame) / 1000 || 0);
  lastFrame = t;
  drawViz(dt);
  updateReadouts();
  const now = Date.now();
  if (now - state.lastEvolveAt > 30_000) evolveTick().catch(() => {});
  // occasional autonomous recording if mic already granted
  if (!state.recording && micStream && state.samples.length < 14 && Math.random() < 0.0008) {
    autoRecord();
  }
  // decay excitement
  if (state.excitement > 0) state.excitement = Math.max(0, state.excitement - dt * 0.15);
  requestAnimationFrame(loop);
}

async function boot() {
  state.genome = loadGenome();
  state.prng = mulberry32((state.genome.seed ^ state.genome.generation) >>> 0);
  viz.cv = document.getElementById('viz');
  viz.ctx = viz.cv.getContext('2d');
  resizeViz();
  window.addEventListener('resize', resizeViz);
  state.store = await openStore();
  const all = await state.store.all();
  state.samples = all.map(sampleMeta);
  state.lastEvolveAt = Date.now();
  state.mood = 'chatter';
  document.body.className = 'awake mood-chatter';
  initInput();
  wireControls();
  requestAnimationFrame((t) => { lastFrame = t; loop(t); });
  // wait for user gesture before creating AudioContext
  const status = document.getElementById('status');
  const kick = async () => {
    if (state.started) return;
    state.started = true;
    status.textContent = 'requesting mic…';
    try {
      await initAudio();
      await ensureMic();
      // start always-on playback loops
      setTimeout(ambientTick, 400);
      setTimeout(performanceTick, 600);
      scheduleNextEvent();
      status.textContent = state.samples.length
        ? 'playing — move mouse · hold click · record more breaths'
        : 'ready — record your first breath (◉) to give it material';
      setTimeout(() => status.classList.add('hidden'), 2400);
    } catch (e) {
      console.error(e);
      status.textContent = 'mic permission denied — click to retry';
      state.started = false;
    }
  };
  document.getElementById('status').addEventListener('click', kick);
  document.addEventListener('click', (e) => {
    if (!state.started && e.target.closest('button, input')) kick();
  }, true);
  document.addEventListener('keydown', (e) => { if (!state.started) kick(); }, { once: true });
}

boot();
