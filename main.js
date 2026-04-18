// TOMI NIASHI — breathing synthesizer simulator
// Sections: prng, genome, store, audio, recorder, voice, evolver, scheduler, input, viz, ui, boot

const DB_NAME = 'tominiashi_synth';
const DB_STORE = 'samples';
const LS_GENOME = 'tn_genome_v1';

const state = {
  ctx: null, master: null, revSend: null, delSend: null, analyser: null, analyserData: null,
  genome: null, store: null, samples: [],
  prng: Math.random,
  mood: 'hush', awake: false, awakeUntil: 0, nextWakeAt: 0, lastEvolveAt: 0,
  mouse: { x: 0.5, y: 0.5, down: false },
  started: false, recording: false,
  bufferCache: new Map(),
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
  const convolver = ctx.createConvolver();
  convolver.buffer = makeIR(ctx, 2.4, 3.0);
  const revSend = ctx.createGain();
  revSend.gain.value = state.genome.params.reverbAmount;
  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = 0.28;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.38;
  delay.connect(feedback);
  feedback.connect(delay);
  const delSend = ctx.createGain();
  delSend.gain.value = 0.18;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  revSend.connect(convolver);
  convolver.connect(master);
  delSend.connect(delay);
  delay.connect(master);
  state.ctx = ctx;
  state.master = master;
  state.analyser = analyser;
  state.revSend = revSend;
  state.delSend = delSend;
  state.analyserData = new Uint8Array(analyser.frequencyBinCount);
}
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
  const { offsetMs, durationMs, rate, pan, gain, mutation } = opts;
  const buf = toAudioBuffer(rec);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const env = ctx.createGain();
  const t0 = ctx.currentTime;
  const dur = Math.max(0.02, durationMs / 1000);
  const atk = Math.min(0.025, dur * 0.35);
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + atk);
  env.gain.setValueAtTime(gain, t0 + dur - atk);
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  let tail = env;
  if (mutation > 0.25) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(600, 14000 * (1 - mutation * 0.85));
    lp.Q.value = 0.5;
    env.connect(lp);
    tail = lp;
  }
  if (mutation > 0.6) {
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
  panner.connect(state.master);
  panner.connect(state.revSend);
  if (Math.random() < 0.4) panner.connect(state.delSend);
  try { src.start(t0, Math.max(0, offsetMs / 1000), dur * 1.1); } catch (e) {}
  src.stop(t0 + dur + 0.08);
  src.onended = () => { try { src.disconnect(); env.disconnect(); panner.disconnect(); } catch (e) {} };
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
// ======== SCHEDULER ========
function scheduleNextWake() {
  const mean = state.genome.params.wakeMeanSeconds;
  const u = Math.max(1e-6, state.prng());
  const delay = Math.max(8, -Math.log(u) * mean * 0.6);
  state.nextWakeAt = Date.now() + delay * 1000;
}
function pickMood() {
  const moods = ['hush', 'chatter', 'memory', 'new'];
  const now = Date.now();
  let oldestAge = 0;
  for (const s of state.samples) { const a = now - s.recordedAt; if (a > oldestAge) oldestAge = a; }
  const fewSamples = state.samples.length < 2;
  const memoryWeight = oldestAge > 3 * 60 * 1000 ? 0.35 : 0.05;
  const newWeight = fewSamples ? 0.5 : 0.15;
  const weights = [0.25, 0.35, memoryWeight, newWeight];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = state.prng() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return moods[i]; }
  return 'chatter';
}
function pickSamplesForMood(mood) {
  const now = Date.now();
  return state.samples.filter((s) => {
    const ageMs = now - s.recordedAt;
    if (mood === 'memory') return ageMs > 90 * 1000 || s.mutationLevel > 0.4;
    if (mood === 'new') return ageMs < 60 * 1000 || s.source === 'mic';
    if (mood === 'hush') return s.mutationLevel < 0.6;
    return true;
  });
}
function wake(manual = false) {
  if (state.awake || !state.samples.length) {
    if (!state.samples.length && manual) { autoRecord(); }
    return;
  }
  state.awake = true;
  state.mood = pickMood();
  const minDur = state.mood === 'hush' ? 4000 : 6000;
  const maxDur = state.mood === 'memory' ? 30000 : 22000;
  state.awakeUntil = Date.now() + minDur + state.prng() * (maxDur - minDur);
  state.genome.activationCount++;
  saveGenome();
  document.body.className = 'awake mood-' + state.mood;
  scheduleNextBurst();
}
function sleep() {
  state.awake = false;
  state.mood = 'hush';
  document.body.className = '';
  scheduleNextWake();
}
function scheduleNextBurst() {
  if (!state.awake) return;
  if (Date.now() > state.awakeUntil) { sleep(); return; }
  const pool = pickSamplesForMood(state.mood);
  if (!pool.length) { sleep(); return; }
  const meta = pool[Math.floor(state.prng() * pool.length)];
  const grainCount = state.mood === 'hush' ? 1 + Math.floor(state.prng() * 2)
    : state.mood === 'chatter' ? 2 + Math.floor(state.prng() * 6)
    : 1 + Math.floor(state.prng() * 4);
  for (let i = 0; i < grainCount; i++) {
    setTimeout(() => playGrainFromMeta(meta), i * (30 + state.prng() * 90));
  }
  const baseInterval = state.mood === 'hush' ? 800 : state.mood === 'chatter' ? 180 : 420;
  const interval = baseInterval + state.prng() * baseInterval * 1.6;
  setTimeout(scheduleNextBurst, interval);
}
async function playGrainFromMeta(meta) {
  const full = await state.store.get(meta.id);
  if (!full) return;
  const p = state.genome.params;
  const grainMs = p.grainMinMs + state.prng() * Math.max(10, p.grainMaxMs - p.grainMinMs);
  const durMs = Math.min(grainMs, meta.durationMs - 20);
  if (durMs < 20) return;
  const maxOffset = Math.max(0, meta.durationMs - durMs);
  const offsetMs = state.prng() * maxOffset;
  const mouseBias = (state.mouse.x - 0.5) * 0.6;
  const pitchStep = (state.prng() * 2 - 1) * p.pitchDrift;
  const rate = Math.pow(2, pitchStep) * (1 + mouseBias * 0.25);
  const pan = (state.prng() * 2 - 1) * 0.7;
  const yGain = 0.3 + (1 - state.mouse.y) * 0.4;
  const gain = (0.35 + state.prng() * 0.3) * yGain;
  triggerGrain(full, { offsetMs, durationMs: durMs, rate: Math.max(0.25, Math.min(4, rate)), pan, gain, mutation: meta.mutationLevel });
  meta.lastPlayedAt = Date.now();
}
async function autoRecord() {
  if (state.recording) return;
  if (state.samples.length >= 30) return;
  if (!micStream) return; // don't prompt mid-sleep if user hasn't granted yet
  await recordBreath(2000 + state.prng() * 2000);
}
// ======== INPUT (mouse) ========
function initInput() {
  const cv = document.getElementById('viz');
  cv.addEventListener('mousemove', (e) => {
    state.mouse.x = e.clientX / window.innerWidth;
    state.mouse.y = e.clientY / window.innerHeight;
  });
  cv.addEventListener('mousedown', (e) => {
    state.mouse.down = true;
    if (!state.started) return;
    playerBurst();
  });
  cv.addEventListener('mouseup', () => { state.mouse.down = false; });
  cv.addEventListener('mouseleave', () => { state.mouse.down = false; });
  // touch
  cv.addEventListener('touchstart', (e) => {
    if (e.touches.length) {
      state.mouse.x = e.touches[0].clientX / window.innerWidth;
      state.mouse.y = e.touches[0].clientY / window.innerHeight;
      state.mouse.down = true;
      playerBurst();
    }
  }, { passive: true });
  cv.addEventListener('touchmove', (e) => {
    if (e.touches.length) {
      state.mouse.x = e.touches[0].clientX / window.innerWidth;
      state.mouse.y = e.touches[0].clientY / window.innerHeight;
    }
  }, { passive: true });
  cv.addEventListener('touchend', () => { state.mouse.down = false; });
  // hold loop
  setInterval(() => {
    if (state.mouse.down && state.started && state.samples.length) {
      playerBurst();
    }
  }, 110);
}
function playerBurst() {
  if (!state.samples.length) return;
  const pool = state.samples;
  const meta = pool[Math.floor(Math.random() * pool.length)];
  const count = 1 + Math.floor(state.mouse.y * 4);
  for (let i = 0; i < count; i++) {
    setTimeout(() => playGrainFromMeta(meta), i * (10 + Math.random() * 50));
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
  viz.phase += dt * (state.awake ? 1.3 : 0.45);
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
  el('r-state').textContent = state.awake ? 'awake' : 'asleep';
  el('r-samples').textContent = state.samples.length;
  el('r-wakes').textContent = g.activationCount;
  el('r-age').textContent = fmtTime(Date.now() - g.birthday);
  const now = Date.now();
  let oldest = 0;
  for (const s of state.samples) { const a = now - s.recordedAt; if (a > oldest) oldest = a; }
  el('r-oldest').textContent = state.samples.length ? fmtTime(oldest) : '—';
  if (state.awake) {
    el('r-nextwake').textContent = 'in ' + fmtTime(state.awakeUntil - now) + ' → sleep';
  } else {
    el('r-nextwake').textContent = state.nextWakeAt ? fmtTime(Math.max(0, state.nextWakeAt - now)) : '—';
  }
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
    try {
      await recordBreath(3000);
    } catch (e) { console.error(e); }
    btn.classList.remove('recording');
    btn.textContent = '◉ record breath';
  });
  el('btn-wake').addEventListener('click', () => wake(true));
  el('btn-sleep').addEventListener('click', () => sleep());
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
  if (!state.awake && state.nextWakeAt && now >= state.nextWakeAt) wake();
  if (state.awake && now >= state.awakeUntil) sleep();
  if (now - state.lastEvolveAt > 30_000) evolveTick().catch(() => {});
  // rare autonomous recording while asleep, if mic already granted
  if (!state.awake && !state.recording && micStream && state.samples.length < 12 && Math.random() < 0.0008) {
    autoRecord();
  }
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
  scheduleNextWake();
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
      status.textContent = 'ready — press ◉ to record your first breath';
      setTimeout(() => status.classList.add('hidden'), 1800);
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
