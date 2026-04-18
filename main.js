// TOMI NIASHI — breathing synthesizer simulator
// Sections: prng, genome, store, audio, recorder, voice, evolver, scheduler, input, viz, ui, boot

import {
  cloudReady,
  pullGenome, pushGenome,
  pullSamples, pushSample, updateSample, deleteSample,
  fetchSampleBlob,
} from './cloud.js';
import { detectHz, rateForTarget, REFERENCE_HZ } from './pitch.js';

const DB_NAME = 'tominiashi_synth';
const DB_STORE = 'samples';
const LS_GENOME = 'tn_genome_v1';
const LS_GENOME_HOME = 'tn_genome_home_v1'; // set on first boot; NEVER overwritten by import
const LS_SHARE_BREATHS = 'tn_share_breaths';
const LS_INCLUDE_SHARED = 'tn_include_shared';

const state = {
  ctx: null, master: null, revSend: null, delSend: null, analyser: null, analyserData: null,
  perfFilter: null, perfGain: null, ambGain: null, eventGain: null, drumBus: null, padBus: null,
  filterLFO: null, filterLFOGain: null,
  genome: null, store: null, samples: [],
  prng: Math.random,
  mood: 'chatter', intensity: 0.55, excitement: 0, lastEvolveAt: 0,
  // chill/excite move intensity persistently. pickSection re-reads the
  // mood's baseline but then adds this bias so the user's last choice
  // sticks across section changes.
  intensityBias: 0,
  scaleIndex: 0, scaleRoot: 0, melodyStep: 0, pendingKeyChange: false,
  mouse: { x: 0.5, y: 0.5, down: false, lastMoveAt: 0 },
  started: false, recording: false,
  bufferCache: new Map(),
  lastGrainAt: 0,
  transport: { bpm: 110, beatIndex: 0, startTime: 0, running: false, keyBar: 0 },
  voices: { kick: true, click: true, shake: true, rain: true, arp: true },
  // Two melody voices share the current scale/root. Lead plays slow + held.
  // Counter plays faster + a diatonic 3rd or 5th above. Both switch together
  // whenever pickSection re-runs.
  melodyVoices: { leadId: null, counterId: null, counterOffset: 2 },
  currentInstrument: 'soft_pad',
  // The *melody line* is the catchy hook the backing instrument + lead
  // vocal both play. A new pattern is picked every 4 bars in pickSection.
  // Patterns are expressed as 7-scale-step degrees (0 = root, 2 = 3rd,
  // 4 = 5th, 7 = octave, etc.).
  melodyLine: null,
  // Second melody line. Populated ~50% of the time by pickMelodyLine
  // so two variations overlap in the same key/tempo.
  melodyLine2: null,
  // Persistence sharing preferences (stored in localStorage)
  shareMyBreaths: localStorage.getItem(LS_SHARE_BREATHS) === '1',
  includeSharedPool: localStorage.getItem(LS_INCLUDE_SHARED) === '1',
  // Three continuous arpeggiator voices. Each has its own pattern, step
  // subdivision, octave offset, gate fraction, and assigned sample.
  // Polyrhythm emerges from mismatched pattern lengths (e.g. 4-vs-6-vs-3).
  arps: [
    { pattern: [0, 4, 7, 4],     subdiv: 16, octave: 0, gate: 0.55, vel: 0.58, sampleId: null, idxOffset: 0 },
    { pattern: [7, 4, 2, 4, 0, 2], subdiv: 16, octave: 0, gate: 0.5,  vel: 0.46, sampleId: null, idxOffset: 2 },
    { pattern: [0, 7, 4],         subdiv: 16, octave: 1, gate: 0.35, vel: 0.4,  sampleId: null, idxOffset: 0 },
  ],
};
const STEPS_PER_BAR = 16;
const KEY_CHANGE_EVERY_BARS = 8;
const ROOT_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function keyLabel() {
  const root = ((state.scaleRoot % 12) + 12) % 12;
  return ROOT_NAMES[root] + ' ' + scaleNow().name;
}

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
    if (raw) {
      const g = JSON.parse(raw);
      // Migration: users from before the home concept won't have a home
      // recorded yet. Their current genome IS their home — claim it now so
      // they never lose the path back.
      if (!localStorage.getItem(LS_GENOME_HOME)) {
        localStorage.setItem(LS_GENOME_HOME, JSON.stringify({ id: g.id }));
      }
      return g;
    }
  } catch (e) {}
  // No genome yet — this is a brand new browser. Create one and mark it as
  // the home for this device forever.
  const g = newGenome();
  localStorage.setItem(LS_GENOME, JSON.stringify(g));
  localStorage.setItem(LS_GENOME_HOME, JSON.stringify({ id: g.id }));
  return g;
}
function saveGenome() {
  try { localStorage.setItem(LS_GENOME, JSON.stringify(state.genome)); } catch (e) {}
}
function homeGenomeId() {
  try {
    const raw = localStorage.getItem(LS_GENOME_HOME);
    if (!raw) return null;
    return JSON.parse(raw).id || null;
  } catch (e) { return null; }
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
    detectedHz: s.detectedHz || null,
    storagePath: s.storagePath || null,
    shared: !!s.shared,
    genomeId: s.genomeId || null,
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
  master.gain.value = 0.9;
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
  delSend.gain.value = 0.18;
  // Performance bus — melody sits up front. Open filter, hot gain.
  const perfFilter = ctx.createBiquadFilter();
  perfFilter.type = 'lowpass';
  perfFilter.frequency.value = 6500;
  perfFilter.Q.value = 0.8;
  const perfGain = ctx.createGain();
  perfGain.gain.value = 1.2;
  perfGain.connect(perfFilter);
  perfFilter.connect(master);
  // Ambient bus — drones, long reverb tail, always very filtered
  const ambFilter = ctx.createBiquadFilter();
  ambFilter.type = 'lowpass';
  ambFilter.frequency.value = 1100;
  ambFilter.Q.value = 0.7;
  const ambGain = ctx.createGain();
  ambGain.gain.value = 0.35;
  ambGain.connect(ambFilter);
  ambFilter.connect(master);
  // Event bus — peaks, arpeggios; sits forward so arps are audible
  const eventGain = ctx.createGain();
  eventGain.gain.value = 1.15;
  eventGain.connect(master);
  // Drum bus — synthesized percussion, gentle by default so melody sits above
  const drumBus = ctx.createGain();
  drumBus.gain.value = 0.42;
  drumBus.connect(master);
  const drumVerb = ctx.createGain();
  drumVerb.gain.value = 0.14;
  drumBus.connect(drumVerb);
  // Pad bus — continuous rain / noise bed. Very soft.
  const padBus = ctx.createGain();
  padBus.gain.value = 0.0;
  padBus.connect(master);
  // Instrument bus — soft synth voices sitting WAY under the vocal melody.
  // Just a hint of harmonic ground, never a focal element.
  const instFilter = ctx.createBiquadFilter();
  instFilter.type = 'lowpass';
  instFilter.frequency.value = 2200;
  instFilter.Q.value = 0.6;
  const instBus = ctx.createGain();
  instBus.gain.value = 0.22;
  instBus.connect(instFilter);
  instFilter.connect(master);
  // A bit of reverb on the instrument so it blends behind the vocals
  const instRev = ctx.createGain();
  instRev.gain.value = 0.55;
  instFilter.connect(instRev);
  // Filter LFO — gentle modulation on perf cutoff so things breathe
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.12;
  lfoGain.gain.value = 500;
  lfo.connect(lfoGain);
  lfoGain.connect(perfFilter.frequency);
  lfo.start();
  // Limiter on the master so occasional loud grains can't blow past
  // everything else. -14 dB threshold with a 15 dB knee and 5:1 ratio —
  // a firmer hand than before so spiky vocal samples get tamed.
  const masterComp = ctx.createDynamicsCompressor();
  masterComp.threshold.value = -14;
  masterComp.knee.value = 15;
  masterComp.ratio.value = 5;
  masterComp.attack.value = 0.004;
  masterComp.release.value = 0.1;
  // routing out: master -> compressor -> analyser -> destination
  master.connect(masterComp);
  masterComp.connect(analyser);
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
  state.drumBus = drumBus;
  state.padBus = padBus;
  state.instBus = instBus;
  state.instFilter = instFilter;
  state.drumVerb = drumVerb;
  state.ambFilter = ambFilter;
  state.filterLFO = lfo;
  state.filterLFOGain = lfoGain;
  state.analyserData = new Uint8Array(analyser.frequencyBinCount);
  drumVerb.connect(convolver);
  instRev.connect(convolver);
}
// ======== INSTRUMENTS (soft, rotating, sit way under the vocal) ========
// Three flavours: soft pad (warm triangle pad), flute (sine + breath noise),
// glass (bell-like inharmonic sines). One is selected per section.
const INSTRUMENTS = ['soft_pad', 'flute', 'glass', 'marimba'];

function scheduleInstrumentNote(when, semis, durationMs, vel = 0.35, kind = null) {
  const ctx = state.ctx;
  if (!ctx || !state.instBus) return;
  const which = kind || state.currentInstrument || 'soft_pad';
  if (which === 'flute')        playFlute(when, semis, durationMs, vel);
  else if (which === 'glass')   playGlass(when, semis, durationMs, vel);
  else if (which === 'marimba') playMarimba(when, semis, durationMs, vel);
  else                          playSoftPad(when, semis, durationMs, vel);
}

function playSoftPad(when, semis, durationMs, vel) {
  const ctx = state.ctx;
  const baseHz = 220 * Math.pow(2, semis / 12);
  const dur = Math.max(0.14, durationMs / 1000);
  const t0 = Math.max(when, ctx.currentTime + 0.001);
  const atk = Math.min(0.18, dur * 0.35);
  const rel = Math.min(0.4, dur * 0.5);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(vel, t0 + atk);
  env.gain.setValueAtTime(vel, t0 + Math.max(atk, dur - rel));
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  const osc1 = ctx.createOscillator(); osc1.type = 'triangle'; osc1.frequency.value = baseHz; osc1.detune.value = -7;
  const osc2 = ctx.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = baseHz; osc2.detune.value = +7;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t0);
  lp.frequency.linearRampToValueAtTime(1500, t0 + atk);
  lp.frequency.linearRampToValueAtTime(800, t0 + dur);
  lp.Q.value = 0.6;
  const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() * 2 - 1) * 0.25;
  osc1.connect(lp); osc2.connect(lp); lp.connect(env); env.connect(pan); pan.connect(state.instBus);
  osc1.start(t0); osc1.stop(t0 + dur + 0.05);
  osc2.start(t0); osc2.stop(t0 + dur + 0.05);
  osc1.onended = () => { try { osc1.disconnect(); osc2.disconnect(); env.disconnect(); pan.disconnect(); lp.disconnect(); } catch (e) {} };
}

function playFlute(when, semis, durationMs, vel) {
  const ctx = state.ctx;
  const baseHz = 440 * Math.pow(2, semis / 12); // flute sits an octave higher
  const dur = Math.max(0.18, durationMs / 1000);
  const t0 = Math.max(when, ctx.currentTime + 0.001);
  const atk = Math.min(0.07, dur * 0.18);
  const rel = Math.min(0.18, dur * 0.35);
  // Sine fundamental
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = baseHz;
  // Vibrato that fades in
  const vib = ctx.createOscillator();
  const vibGain = ctx.createGain();
  vib.frequency.value = 5.4;
  vibGain.gain.setValueAtTime(0, t0);
  vibGain.gain.linearRampToValueAtTime(2.2, t0 + Math.min(0.35, dur * 0.4));
  vib.connect(vibGain); vibGain.connect(osc.detune);
  vib.start(t0); vib.stop(t0 + dur + 0.05);
  // Breath noise — short bandpassed burst at the attack
  const nLen = Math.floor(ctx.sampleRate * Math.min(0.25, dur));
  const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nLen; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nLen, 1.6);
  const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
  const nbp = ctx.createBiquadFilter(); nbp.type = 'bandpass';
  nbp.frequency.value = baseHz * 1.6; nbp.Q.value = 5;
  const nGain = ctx.createGain(); nGain.gain.value = vel * 0.18;
  nSrc.connect(nbp); nbp.connect(nGain);
  // Envelope on the sine voice
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(vel, t0 + atk);
  env.gain.setValueAtTime(vel, t0 + Math.max(atk, dur - rel));
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
  const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() * 2 - 1) * 0.2;
  osc.connect(env); env.connect(lp); lp.connect(pan);
  nGain.connect(pan);
  pan.connect(state.instBus);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
  nSrc.start(t0); nSrc.stop(t0 + nLen / ctx.sampleRate + 0.02);
  osc.onended = () => { try { osc.disconnect(); env.disconnect(); pan.disconnect(); lp.disconnect(); nGain.disconnect(); } catch (e) {} };
}

function playMarimba(when, semis, durationMs, vel) {
  // Wooden mallet tone: sine fundamental with a sharp attack + fast decay
  // plus a quieter octave-up partial for that hollow marimba ring. A touch
  // of pitch-envelope on the attack gives it the characteristic "thunk".
  const ctx = state.ctx;
  const baseHz = 330 * Math.pow(2, semis / 12);   // A bit lower than flute
  const dur = Math.max(0.25, Math.min(0.9, (durationMs / 1000) * 1.1));
  const t0 = Math.max(when, ctx.currentTime + 0.001);
  const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.setValueAtTime(baseHz * 1.08, t0);
  o1.frequency.exponentialRampToValueAtTime(baseHz, t0 + 0.018);
  const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = baseHz * 4;
  const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = baseHz * 6;
  const e1 = ctx.createGain();
  e1.gain.setValueAtTime(0.001, t0);
  e1.gain.exponentialRampToValueAtTime(vel * 1.0, t0 + 0.004);
  e1.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  const e2 = ctx.createGain();
  e2.gain.setValueAtTime(0.001, t0);
  e2.gain.exponentialRampToValueAtTime(vel * 0.32, t0 + 0.003);
  e2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
  const e3 = ctx.createGain();
  e3.gain.setValueAtTime(0.001, t0);
  e3.gain.exponentialRampToValueAtTime(vel * 0.14, t0 + 0.002);
  e3.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
  // A gentle lowpass rounds the harsher upper harmonics
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600; lp.Q.value = 0.7;
  const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() * 2 - 1) * 0.35;
  o1.connect(e1);
  o2.connect(e2);
  o3.connect(e3);
  e1.connect(lp); e2.connect(lp); e3.connect(lp);
  lp.connect(pan); pan.connect(state.instBus);
  o1.start(t0); o1.stop(t0 + dur + 0.05);
  o2.start(t0); o2.stop(t0 + 0.18);
  o3.start(t0); o3.stop(t0 + 0.1);
  o1.onended = () => { try { o1.disconnect(); o2.disconnect(); o3.disconnect(); e1.disconnect(); e2.disconnect(); e3.disconnect(); lp.disconnect(); pan.disconnect(); } catch (e) {} };
}

function playGlass(when, semis, durationMs, vel) {
  // FM-bell-ish: fundamental sine + inharmonic partial that decays fast.
  const ctx = state.ctx;
  const baseHz = 440 * Math.pow(2, semis / 12);
  const dur = Math.max(0.5, (durationMs / 1000) * 1.4);
  const t0 = Math.max(when, ctx.currentTime + 0.001);
  const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = baseHz;
  const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = baseHz * 2.76;
  const e1 = ctx.createGain();
  e1.gain.setValueAtTime(0.0001, t0);
  e1.gain.exponentialRampToValueAtTime(vel * 0.85, t0 + 0.005);
  e1.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const e2 = ctx.createGain();
  e2.gain.setValueAtTime(0.0001, t0);
  e2.gain.exponentialRampToValueAtTime(vel * 0.35, t0 + 0.002);
  e2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.4);
  const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() * 2 - 1) * 0.4;
  o1.connect(e1); e1.connect(pan);
  o2.connect(e2); e2.connect(pan);
  pan.connect(state.instBus);
  o1.start(t0); o1.stop(t0 + dur + 0.05);
  o2.start(t0); o2.stop(t0 + dur + 0.05);
  o1.onended = () => { try { o1.disconnect(); o2.disconnect(); e1.disconnect(); e2.disconnect(); pan.disconnect(); } catch (e) {} };
}
// ======== PERCUSSION (synthesized, organic) ========
function scheduleKick(when, vel = 0.7) {
  if (!state.voices.kick) return;
  const ctx = state.ctx;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, when);
  osc.frequency.exponentialRampToValueAtTime(38, when + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.01, vel), when + 0.006);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.32);
  // a little noise thud for body
  const nBuf = ctx.createBuffer(1, ctx.sampleRate * 0.04, ctx.sampleRate);
  const nd = nBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nd.length, 2);
  const nSrc = ctx.createBufferSource(); nSrc.buffer = nBuf;
  const nLp = ctx.createBiquadFilter(); nLp.type = 'lowpass'; nLp.frequency.value = 180;
  const nG = ctx.createGain(); nG.gain.value = vel * 0.35;
  nSrc.connect(nLp); nLp.connect(nG); nG.connect(state.drumBus);
  osc.connect(g); g.connect(state.drumBus);
  osc.start(when); osc.stop(when + 0.4);
  nSrc.start(when); nSrc.stop(when + 0.04);
}
function scheduleClick(when, vel = 0.5, hz = 2400) {
  if (!state.voices.click) return;
  const ctx = state.ctx;
  const len = Math.floor(ctx.sampleRate * 0.035);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.5);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = hz;
  bp.Q.value = 3 + Math.random() * 4;
  const g = ctx.createGain();
  g.gain.value = vel * 0.28;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() * 2 - 1) * 0.7;
  src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(state.drumBus);
  src.start(when); src.stop(when + 0.06);
}
function scheduleShake(when, vel = 0.4) {
  if (!state.voices.shake) return;
  const ctx = state.ctx;
  const len = Math.floor(ctx.sampleRate * 0.09);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.4);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3800;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.001, when);
  g.gain.exponentialRampToValueAtTime(vel * 0.22, when + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.11);
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() * 2 - 1) * 0.9;
  src.connect(hp); hp.connect(g); g.connect(pan); pan.connect(state.drumBus);
  src.start(when); src.stop(when + 0.12);
}
function startRainPad() {
  if (!state.voices.rain) return;
  const ctx = state.ctx;
  // long looping noise buffer
  const len = Math.floor(ctx.sampleRate * 4);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.05) * 0.985;
      d[i] = last;
    }
  }
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.7;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
  const g = ctx.createGain(); g.gain.value = 0.45;
  src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(state.padBus);
  const rg = ctx.createGain(); rg.gain.value = 0.25;
  g.connect(rg); rg.connect(state.revSend);
  src.start();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.06;
  lfoGain.gain.value = 350;
  lfo.connect(lfoGain); lfoGain.connect(bp.frequency);
  lfo.start();
  // Sparse raindrops only — infrequent, quieter, and always darker so they
  // don't compete with melody clarity.
  function drop() {
    if (!state.voices.rain) { setTimeout(drop, 1400); return; }
    scheduleClick(ctx.currentTime + 0.01, 0.18 + Math.random() * 0.12, 1200 + Math.random() * 1400);
    setTimeout(drop, 1400 + Math.random() * 3600);
  }
  setTimeout(drop, 1800);
  // Fade in pad much softer than before; mouse modulation can nudge it.
  state.padBus.gain.cancelScheduledValues(ctx.currentTime);
  state.padBus.gain.setValueAtTime(0, ctx.currentTime);
  state.padBus.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 5);
}
// ======== SCALES / NOTES ========
// Kept to pleasant, consonant scales. Major/minor + modal siblings that all
// sound musical over triadic/pentatonic melodies.
const SCALES = [
  { name: 'major pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'major',            steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'natural minor',    steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'dorian',           steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'mixolydian',       steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'lydian',           steps: [0, 2, 4, 6, 7, 9, 11] },
];
// Singer-friendly roots: C, D, F, G, A (and their minor equivalents).
const NICE_ROOTS = [-12, -10, -7, -5, -3, 0, 2, 5, 7, 9];
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
// Pitch-aware version: if the sample's detected fundamental is known, land
// the note exactly on the target pitch (choosing the nearest octave so we
// don't chipmunk).  Falls back to the naive rate-shift when detection hasn't
// happened yet for that sample.
function rateForDegreeOnSample(degree, sampleHz, octaveBias = 0) {
  if (!sampleHz) return rateForSemitones(degreeToSemitones(degree) + octaveBias * 12);
  const targetHz = REFERENCE_HZ * Math.pow(2, degreeToSemitones(degree) / 12);
  return rateForTarget(sampleHz, targetHz, octaveBias);
}
// ======== RECORDER ========
// Peak-normalize a PCM buffer in place so its loudest sample sits at
// `targetPeak`. Only scales DOWN — leaves quieter recordings alone so we
// don't amplify noise floors. Returns the scale factor applied (1 if
// untouched).
function normalizePcmInPlace(pcm, targetPeak = 0.65) {
  if (!pcm || !pcm.length) return 1;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  if (peak <= targetPeak) return 1;
  const factor = targetPeak / peak;
  for (let i = 0; i < pcm.length; i++) pcm[i] *= factor;
  return factor;
}
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
    // Peak-normalize loud recordings so a shouted breath doesn't dominate
    // quiet ones.  Only scale DOWN (factor < 1) — we don't want to boost
    // quiet samples and amplify their noise floor. Target peak 0.8 is
    // "pretty hot but not clipping".
    normalizePcmInPlace(pcm, 0.65);
    // Run YIN pitch detection so we can pitch-correct playback. Synchronous
    // but fast (~20-40ms for 2048 samples); acceptable at record time.
    const detectedHz = detectHz(pcm, audioBuf.sampleRate);
    const record = {
      id: crypto.randomUUID(),
      pcm, sampleRate: audioBuf.sampleRate,
      recordedAt: Date.now(), lastPlayedAt: 0,
      generation: state.genome.generation,
      mutationLevel: 0, source: 'mic', survivalScore: 1,
      parentId: null,
      storagePath: null,
      shared: !!state.shareMyBreaths,
      genomeId: state.genome.id,
      detectedHz,
    };
    await state.store.add(record);
    const meta = sampleMeta(record);
    meta.shared = record.shared;
    meta.storagePath = null;
    state.samples.push(meta);
    // Fire-and-forget cloud upload. Keeps local playback snappy; sync is best-effort.
    if (cloudReady) {
      pushSample({
        id: record.id,
        genome_id: state.genome.id,
        blob, mime: blob.type,
        sample_rate: record.sampleRate,
        duration_ms: meta.durationMs,
        recorded_at: record.recordedAt,
        generation: record.generation,
        mutation_level: 0,
        source: 'mic',
        survival_score: 1,
        parent_id: null,
        shared: record.shared,
        detected_hz: detectedHz,
      }).then(path => {
        if (path) { record.storagePath = path; meta.storagePath = path; state.store.update(record.id, { storagePath: path }).catch(() => {}); }
      }).catch(e => console.warn('cloud upload failed', e));
    }
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
// Lazily build and cache a time-reversed copy of the PCM so a grain can
// literally play backward.  Web Audio's playbackRate can't go negative, so
// we flip the Float32Array once per sample and cache the resulting buffer.
function toReversedAudioBuffer(rec) {
  if (!state.reverseBufferCache) state.reverseBufferCache = new Map();
  const cached = state.reverseBufferCache.get(rec.id);
  if (cached) return cached;
  const src = rec.pcm;
  const N = src.length;
  const reversed = new Float32Array(N);
  for (let i = 0; i < N; i++) reversed[i] = src[N - 1 - i];
  const buf = state.ctx.createBuffer(1, N, rec.sampleRate);
  buf.copyToChannel(reversed, 0);
  state.reverseBufferCache.set(rec.id, buf);
  if (state.reverseBufferCache.size > 24) {
    const first = state.reverseBufferCache.keys().next().value;
    state.reverseBufferCache.delete(first);
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
    when = null,           // schedule ahead (ctx.currentTime units)
    reverse = null,        // explicit override; null => roll the dice below
  } = opts;
  // Reverse probability: older/more-mutated samples are more likely to
  // surface in reverse (a quiet nod to the derivation path that already
  // reverses 30% of child samples).  For fresh grains it's a rare spice
  // (~6%); past mutation 0.5 we boost toward 15%.
  const playReversed = reverse != null ? !!reverse
    : Math.random() < (0.05 + Math.max(0, mutation - 0.3) * 0.2);
  const buf = playReversed ? toReversedAudioBuffer(rec) : toAudioBuffer(rec);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  if (detuneCents) { try { src.detune.value = detuneCents; } catch (e) {} }
  const env = ctx.createGain();
  const t0 = when != null ? Math.max(when, ctx.currentTime + 0.001) : ctx.currentTime;
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
  // Per-grain color filter. Only applied when explicitly requested, when the
  // sample is heavily mutated, or for ambient grains. Plain melody grains
  // pass straight through so vocals stay clear (the perf bus filter already
  // shapes them).
  const wantFilter = filterType != null || filterHz != null || layer === 'ambient' || mutation > 0.4;
  if (wantFilter) {
    const bq = ctx.createBiquadFilter();
    if (filterType) bq.type = filterType;
    else bq.type = mutation > 0.4 ? 'lowpass' : 'lowpass';
    let freq = filterHz;
    if (freq == null) {
      if (layer === 'ambient') freq = 700 + Math.random() * 1200;
      // Decay lowpass: less aggressive than before. At mutation=1 the floor
      // is 2.5 kHz (was 2.4 kHz but the old slope darkened more quickly);
      // the max attenuation factor drops 0.85 -> 0.6.
      else freq = Math.max(1400, 16000 * (1 - mutation * 0.6));
    }
    bq.frequency.value = freq;
    bq.Q.value = filterQ != null ? filterQ : (bq.type === 'bandpass' ? 2.5 : 0.55);
    env.connect(bq);
    tail = bq;
  }
  // Bitcrush — now quite gentle.  Only very old samples (mutation > 0.8)
  // and only ~20% of those, and never below 6 bits (64 steps) so the grit
  // is mostly a soft texture rather than an interruption.  Wet-only output
  // is blended against the dry tail via a 55/45 wet-dry mix so even when
  // it fires, the original signal is mostly intact.
  if (mutation > 0.8 && Math.random() < 0.2) {
    const ws = ctx.createWaveShaper();
    const bits = Math.max(6, Math.floor(11 - mutation * 5));
    const steps = Math.pow(2, bits);
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1024) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    ws.curve = curve;
    const wet = ctx.createGain(); wet.gain.value = 0.45;
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    const merge = ctx.createGain();
    tail.connect(ws); ws.connect(wet); wet.connect(merge);
    tail.connect(dry); dry.connect(merge);
    tail = merge;
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
  // A derived clip may have a different detected pitch than the parent — if
  // we reversed or sliced out a specific vowel, the fundamental can shift.
  // Re-detect on the child.  Inherit the parent's pitch as a best guess if
  // detection fails on the slice.
  const detectedHz = detectHz(child, sr) || parentMeta.detectedHz || null;
  const rec = {
    id: crypto.randomUUID(),
    pcm: child, sampleRate: sr,
    recordedAt: Date.now(), lastPlayedAt: 0,
    generation: state.genome.generation,
    mutationLevel: Math.min(0.7, (parentMeta.mutationLevel || 0) + 0.1),
    source: 'derived', survivalScore: 0.8,
    parentId: parentMeta.id,
    detectedHz,
  };
  await state.store.add(rec);
  state.samples.push(sampleMeta(rec));
}
async function evolveTick() {
  const params = state.genome.params;
  const cloudSampleUpdates = [];
  for (const meta of state.samples) {
    meta.mutationLevel = Math.min(1, meta.mutationLevel + params.degradationRate * (0.5 + state.prng()));
    if (state.prng() < 0.06) meta.survivalScore *= 0.88;
    try { await state.store.update(meta.id, { mutationLevel: meta.mutationLevel, survivalScore: meta.survivalScore }); } catch (e) {}
    // Only sync samples that actually live in the cloud (mic recordings).
    if (cloudReady && meta.storagePath) {
      cloudSampleUpdates.push({ id: meta.id, patch: { mutation_level: meta.mutationLevel, survival_score: meta.survivalScore } });
    }
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
    if (cloudReady && s.storagePath) {
      deleteSample(s.id, s.storagePath).catch(() => {});
    }
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
  // Best-effort cloud sync for the genome + any cloud-backed samples
  if (cloudReady) {
    pushGenome(state.genome).catch(() => {});
    for (const u of cloudSampleUpdates) {
      updateSample(u.id, u.patch).catch(() => {});
    }
  }
}
// ======== SCHEDULER (grid transport) ========
// A musical clock. Every 16 steps per bar. Key changes every N bars.
// Excite/chill modify tempo + drum density + arpeggio rate persistently.
function pickSamplesForMoodInline(mood) { return pickSamplesForMood(mood); }
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
function stepMelody() {
  const bias = state.genome.params.melodicBias;
  let jump;
  if (state.prng() < bias) jump = (state.prng() < 0.5 ? -1 : 1);
  else jump = Math.floor((state.prng() * 2 - 1) * 4);
  state.melodyStep += jump;
  if (state.melodyStep > 14) state.melodyStep = 8 + Math.floor(state.prng() * 4);
  if (state.melodyStep < -10) state.melodyStep = -4 - Math.floor(state.prng() * 4);
  return state.melodyStep;
}

// Section picker: every 4 bars. Re-picks mood, intensity, and — crucially —
// the two melody voice samples so lead + counter change together.
// ======== MELODY LINE (the catchy hook) ========
// Pop-shaped phrases. Every number is a scale degree (0 = root, 2 = 3rd,
// 4 = 5th, 7 = octave). These are designed to have clear contour and
// memorable shape — question/answer, ascent/descent, pedal-point, etc.
// The backing instrument and the lead vocal both play these.
const MELODY_LINES = [
  // 8-step: short, anthemic
  [0, 2, 4, 2, 0, 4, 2, 0],               // classic do-mi-sol pop
  [0, 4, 2, 4, 0, 2, 4, 7],               // with lift to the octave
  [4, 2, 0, 2, 4, 5, 4, 2],               // start on 5, come down
  [0, 2, 4, 5, 4, 2, 0, -3],              // drop to the 6 below for sweetness
  [7, 4, 2, 0, 2, 4, 7, 4],               // octave cascade + return
  [0, 1, 2, 4, 2, 1, 0, 4],               // stepwise rise with a leap home
  [0, 4, 2, 0, 4, 2, 0, -1],              // rocking pedal
  [2, 4, 5, 4, 2, 0, 2, 4],               // neighbour figure
  [0, 4, 7, 4, 5, 4, 2, 0],               // triad climb, step-down fall
  [4, 5, 4, 2, 0, 2, 4, -3],              // pop-verse shape
  [0, 2, 1, 2, 4, 5, 4, 2],               // passing tones
  [0, 7, 4, 2, 0, -3, 0, 4],              // wide interval hook
  // 16-step: full-hook developments (the Max Cooper long-line shape)
  [0, 2, 4, 2, 0, 2, 4, 7, 4, 2, 0, 2, 4, 2, 0, -3],
  [0, 2, 4, 5, 4, 2, 0, -3, 0, 2, 4, 2, 0, 2, 4, 7],
  [0, 4, 2, 0, 4, 2, 0, -3, 0, 4, 2, 4, 7, 4, 2, 0],
  [0, 2, 4, 2, 4, 5, 7, 5, 4, 2, 0, 2, 4, 2, 0, -3],
  [4, 2, 0, 2, 4, 7, 4, 2, 0, -3, 0, 2, 4, 2, 0, 2],
  [0, 1, 2, 4, 5, 4, 2, 1, 0, 2, 4, 2, 0, -1, -3, 0],
];

function pickMelodyLine() {
  const patt = MELODY_LINES[Math.floor(state.prng() * MELODY_LINES.length)];
  // 8-step patterns fit nicely in 1 bar at 8th notes OR 2 bars at 16th notes.
  // 16-step patterns fit 1 bar at 16ths OR 2 bars at 8ths.
  // Occasionally we pick 16ths so the melody moves very fast (Max-Cooper-ish).
  const sub = state.prng() < 0.55 ? 8 : 16;
  // Melody octave drifts per section so the tune doesn't live in one
  // register.  More lower-octave exploration than before (the brighter
  // instruments were crowding the top otherwise).
  const octRoll = state.prng();
  const oct = octRoll < 0.1 ? -2
            : octRoll < 0.5 ? -1
            : octRoll < 0.9 ? 0
            : 1;
  state.melodyLine = {
    pattern: patt,
    subdiv: sub,
    octave: oct,
    vel: 0.24 + state.prng() * 0.08,
    gateFrac: sub === 8 ? 0.72 : 0.55,
    pan: -0.2,
  };
  // ~50% of the time, spawn a second melody line that runs concurrently.
  // Same subdivision (so they stay rhythmically aligned), different pattern
  // from the library, slightly quieter and panned opposite.  Shares the
  // current key so they harmonise automatically.
  if (state.prng() < 0.5) {
    let patt2 = MELODY_LINES[Math.floor(state.prng() * MELODY_LINES.length)];
    // Try to avoid picking the same pattern object
    for (let k = 0; k < 3 && patt2 === patt; k++) {
      patt2 = MELODY_LINES[Math.floor(state.prng() * MELODY_LINES.length)];
    }
    // Second line sits a diatonic 3rd or 5th away so the two lines form
    // a simple counterpoint in-key.  Sometimes at +1 octave for sparkle.
    const degShift = state.prng() < 0.5 ? 2 : (state.prng() < 0.5 ? 4 : 7);
    const oct2 = state.prng() < 0.25 ? oct + 1 : oct;
    state.melodyLine2 = {
      pattern: patt2,
      subdiv: sub,
      octave: oct2,
      degShift,                              // added to every pattern degree
      vel: 0.17 + state.prng() * 0.07,       // quieter than primary
      gateFrac: sub === 8 ? 0.6 : 0.45,
      pan: 0.3,
      phaseOffset: state.prng() < 0.35 ? 2 : 0, // sometimes start half-beat late
    };
  } else {
    state.melodyLine2 = null;
  }
}

function pickSection() {
  const r = state.prng();
  state.mood = r < 0.3 ? 'chatter' : r < 0.55 ? 'new' : r < 0.8 ? 'memory' : 'hush';
  document.body.className = 'awake mood-' + state.mood;
  const baseIntensity = state.mood === 'hush' ? 0.4
                      : state.mood === 'chatter' ? 0.78
                      : state.mood === 'memory' ? 0.55
                      : 0.86;
  // Apply the user's chill/excite bias on top of the mood baseline so the
  // last button press keeps affecting intensity even across section changes.
  state.intensity = Math.max(0.1, Math.min(1, baseIntensity + state.intensityBias));
  // Assign samples for the two voices from the current mood's pool.
  if (state.samples.length) {
    const pool = pickSamplesForMood(state.mood);
    const lead = pool[Math.floor(state.prng() * pool.length)];
    let counter = pool[Math.floor(state.prng() * pool.length)];
    for (let k = 0; k < 4 && counter && lead && counter.id === lead.id && pool.length > 1; k++) {
      counter = pool[Math.floor(state.prng() * pool.length)];
    }
    state.melodyVoices.leadId = lead ? lead.id : null;
    state.melodyVoices.counterId = counter ? counter.id : null;
    state.melodyVoices.counterOffset = state.prng() < 0.7 ? 2 : 4;
  }
  // Rotate the backing instrument per section. Marimba leads the rotation
  // now — woody + punchy + pop-friendly.  soft_pad is second for its
  // blendable warmth. Flute and glass are the bright spice.
  const ir = state.prng();
  state.currentInstrument = ir < 0.45 ? 'marimba'
                          : ir < 0.75 ? 'soft_pad'
                          : ir < 0.92 ? 'flute'
                          : 'glass';
  // New melody line for this section — the hook.
  pickMelodyLine();
  // Reassign the three continuous arpeggiator voices.
  pickArps();
}

// Reassign all three arp voices: new patterns, subdivisions, octaves, samples.
// Pattern *lengths* are picked to create polyrhythm (e.g. 4 vs 6 vs 3 steps
// cycling at the same 16th subdivision produces a constantly reshuffling
// hook). Subdivisions occasionally differ for a speedier counter-voice.
// Flute and glass sit at an A4 reference and get very bright (inharmonic
// partials on glass, vibrato sparkle on flute). Octave +1 on top of that
// is piercing. Clamp them down; marimba and soft_pad have headroom.
function safeOctaveForInstrument(inst, desired) {
  if (inst === 'flute' || inst === 'glass') return Math.max(-2, Math.min(0, desired));
  if (inst === 'marimba')                   return Math.max(-1, Math.min(1, desired));
  return Math.max(-2, Math.min(1, desired)); // soft_pad
}

function pickArps() {
  const subdivChoice = state.prng();
  const sub1 = 16;
  const sub2 = subdivChoice < 0.25 ? 8 : 16;
  const sub3 = subdivChoice < 0.4 ? 32 : subdivChoice < 0.8 ? 16 : 8;
  // Voice 1 (counter) now explores lower registers more often — 20% bass,
  // 45% -1 oct, 35% middle. Nothing above 0 here, keeps it warm.
  const oct2Roll = state.prng();
  const oct2Desired = oct2Roll < 0.2 ? -2 : oct2Roll < 0.65 ? -1 : 0;
  // Voice 2 (ornament) usually sits high, but 15% of the time it DROPS an
  // octave for a surprising dark-ornament flavour. Clamped per-instrument
  // below so flute/glass still stay below the ear-piercing zone.
  const oct3Roll = state.prng();
  const oct3Desired = oct3Roll < 0.15 ? -1
                    : oct3Roll < 0.45 ? 0
                    : oct3Roll < 0.9  ? 1
                    : 2;
  const poppyTop = Math.min(6, ARP_PATTERNS.length);
  const pat1 = ARP_PATTERNS[Math.floor(state.prng() * poppyTop)];
  const pat2 = ARP_PATTERNS[Math.floor(state.prng() * ARP_PATTERNS.length)];
  const pat3 = ARP_PATTERNS[Math.floor(state.prng() * ARP_PATTERNS.length)];
  // Voice 0 is a VOCAL arp (uses a sample grain, routed through playNote).
  // Voices 1 and 2 are instrument synths, each picking a distinct timbre.
  const vocalSample = state.samples.length
    ? pickSamplesForMood(state.mood)[Math.floor(state.prng() * Math.max(1, pickSamplesForMood(state.mood).length))]
    : null;
  // Weighted instrument picker mirrors pickSection's bias toward marimba.
  const pickInst = () => {
    const r = state.prng();
    if (r < 0.45) return 'marimba';
    if (r < 0.72) return 'soft_pad';
    if (r < 0.9)  return 'flute';
    return 'glass';
  };
  const inst1 = pickInst();
  let inst2 = pickInst();
  for (let k = 0; k < 4 && inst2 === inst1; k++) inst2 = pickInst();
  state.arps = [
    // Voice 0 — vocal grain arpeggio, center pan, held slightly longer.
    { pattern: pat1, subdiv: sub1, octave: 0,   gate: 0.55, vel: 0.48, sampleId: vocalSample ? vocalSample.id : null, idxOffset: 0 },
    // Voice 1 — instrument counter, left pan.
    { pattern: pat2, subdiv: sub2, octave: safeOctaveForInstrument(inst1, oct2Desired), gate: 0.5,  vel: 0.42, instrument: inst1, idxOffset: Math.floor(state.prng() * pat2.length) },
    // Voice 2 — instrument ornament, right pan, highest register the
    // instrument safely allows (flute/glass capped at octave 0).
    { pattern: pat3, subdiv: sub3, octave: safeOctaveForInstrument(inst2, oct3Desired), gate: 0.35, vel: 0.34, instrument: inst2, idxOffset: Math.floor(state.prng() * pat3.length) },
  ];
}
// Fire one arp voice. If voice.sampleId is set, plays a vocal-sample grain
// via playNote; otherwise plays the assigned instrument synth. subdiv=16
// => one note per 16th, 8 => every other, 32 => two per 16th.
function fireArpVoice(voice, voiceIdx, i, when) {
  if (!voice || !voice.pattern || !voice.pattern.length) return;
  const sixteenth = beatDuration() / 4;
  const events = [];
  if (voice.subdiv === 32) {
    events.push({ when: when,                   patIdx: (voice.idxOffset + i * 2) });
    events.push({ when: when + sixteenth * 0.5, patIdx: (voice.idxOffset + i * 2 + 1) });
  } else if (voice.subdiv === 16) {
    events.push({ when: when, patIdx: (voice.idxOffset + i) });
  } else if (voice.subdiv === 8) {
    if (i % 2 !== 0) return;
    events.push({ when: when, patIdx: (voice.idxOffset + i / 2) });
  } else {
    return;
  }
  const restProb = voice.restProb != null ? voice.restProb
                 : voiceIdx === 2 ? 0.32
                 : voiceIdx === 1 ? 0.18
                 : 0.1;
  const isVocal = !!voice.sampleId;
  // For vocal voices, resolve the sample once per fire and kick off a single
  // store fetch for all sub-events. For synth voices we schedule directly.
  let vocalMeta = null;
  if (isVocal) {
    vocalMeta = state.samples.find(s => s.id === voice.sampleId);
    if (!vocalMeta) vocalMeta = pickSample(state.samples);
    if (!vocalMeta) return;
  }
  const firePromise = isVocal ? state.store.get(vocalMeta.id).catch(() => null) : Promise.resolve(null);
  const basePan = voiceIdx === 1 ? -0.55 : voiceIdx === 2 ? 0.55 : 0;
  firePromise.then(full => {
    for (const ev of events) {
      if (state.prng() < restProb) continue;
      const patLen = voice.pattern.length;
      const idx = ((Math.floor(ev.patIdx) % patLen) + patLen) % patLen;
      const deg = voice.pattern[idx];
      const maxDurMs = voice.subdiv === 32 ? 110 : voice.subdiv === 16 ? 220 : 380;
      const durMs = Math.min((sixteenth * 1000) * voice.gate * (voice.subdiv === 32 ? 0.5 : 1), maxDurMs);
      const accent = (i % 4 === 0) ? 1.0 : (i % 2 === 0) ? 0.88 : 0.78;
      const vel = voice.vel * accent * (0.85 + state.prng() * 0.2) * (1 + state.excitement * 0.08);
      if (isVocal && full) {
        // Vocal grain: use pitch-aware playNote so it tracks the current
        // scale. Short grain so fast arps stay articulate.
        playNote(full, vocalMeta, ev.when, {
          degree: deg + voice.octave * 7,
          vel,
          durationMs: durMs,
          layer: 'event',
          panOverride: basePan + (state.prng() * 2 - 1) * 0.2,
        });
      } else if (voice.instrument) {
        const semis = degreeToSemitones(deg) + voice.octave * 12;
        scheduleInstrumentNote(ev.when, semis, durMs, vel, voice.instrument);
      }
    }
  });
}

function tickArps(i, when) {
  if (!state.arps) return;
  for (let v = 0; v < state.arps.length; v++) {
    fireArpVoice(state.arps[v], v, i, when);
  }
}

function pickNewKey() {
  // Pop structures: major is the spine, natural minor is the sad-pretty
  // sibling, dorian/mixolydian are the interesting-but-still-catchy modes.
  // Pentatonics get tiny weights — they're there as rare contrast.
  // Order matches SCALES: [maj-pent, min-pent, major, nat-min, dorian, mixolydian, lydian]
  const scaleWeights = [0.04, 0.03, 0.42, 0.25, 0.16, 0.07, 0.03];
  let r = state.prng();
  let i = 0;
  for (; i < scaleWeights.length - 1; i++) { if ((r -= scaleWeights[i]) < 0) break; }
  state.scaleIndex = i;
  state.scaleRoot = NICE_ROOTS[Math.floor(state.prng() * NICE_ROOTS.length)];
}

// --- Note trigger aligned to grid ---
function playNote(full, meta, when, opts = {}) {
  const {
    degree = stepMelody(),
    vel = 0.55,
    durationMs = null,
    layer = 'perf',
    filterHz = null,     // null => no per-grain filter for melody (perf bus shapes it)
    extraDetune = 0,
    panOverride = null,
    octaveBias = 0,       // shift up/down octaves (e.g. ambient uses -1 or -2)
  } = opts;
  // Mouse X nudges the transposition but stays small enough that the key
  // remains obvious.
  const transposedDegree = degree + Math.round((state.mouse.x - 0.5) * 6);
  const dur = durationMs != null ? durationMs : 500 + state.prng() * 500;
  const clampedDur = Math.min(dur, Math.max(60, meta.durationMs - 20));
  const maxOffset = Math.max(0, meta.durationMs - clampedDur);
  // Prefer the meaty middle of the sample for vocal clarity
  const offsetMs = Math.min(maxOffset, Math.max(0, meta.durationMs * 0.1 + state.prng() * maxOffset * 0.7));
  // Use the sample's detected fundamental if we've analysed it; fall back to
  // naive degree-to-rate mapping otherwise.
  const rate = rateForDegreeOnSample(transposedDegree, meta.detectedHz || full.detectedHz, octaveBias);
  const pan = panOverride != null ? panOverride : (Math.sin(state.melodyStep * 0.6) * 0.45 + (state.prng() * 2 - 1) * 0.2);
  triggerGrain(full, {
    offsetMs, durationMs: clampedDur,
    rate: Math.max(0.25, Math.min(4, rate)),
    pan, gain: vel,
    mutation: meta.mutationLevel,
    layer, filterHz,
    detuneCents: (state.prng() * 2 - 1) * 5 + extraDetune,
    when,
  });
  meta.lastPlayedAt = Date.now();
}

// Arpeggio pattern library — pop-pleasing shapes expressed as scale degrees.
// Mostly triads + seventh voicings with some octave leaps and descending
// hooks. Patterns of different lengths produce polyrhythmic overlap when
// assigned to different arp voices at the same subdivision.
const ARP_PATTERNS = [
  [0, 4, 7, 4],                 // root-3rd-5th-3rd  (classic pop arp)
  [0, 2, 4, 7, 4, 2],           // ascending + return
  [0, 4, 7, 9, 7, 4],           // reach to the 6
  [7, 4, 2, 0, 2, 4],           // descend and return
  [0, 7, 4, 7],                 // bouncing root-octave-3rd
  [0, 2, 4, 5, 4, 2],           // stepwise lilt
  [0, 4, 2, 7, 4, 9],           // zig-zag with leaps
  [0, 4, 7, 4, 9, 4, 7, 4],     // pivoting on the 3rd
  [0, 7, 0, 4, 0, 7, 0, 9],     // bass-pedal with upper voice
  [4, 7, 9, 7, 4, 2],           // circling a high cluster
  [0, 2, 4, 2, 0, -3],          // drop to the 6 below
  [0, 11, 7, 4, 2, 4],          // leading tone pulled down home
];

function scheduleArpeggio(startWhen, stepsBeats = 8, baseDegree = 0, velScale = 1) {
  // One-shot excited burst used by the excite button.  Plays through the
  // instrument synth to match the continuous arp voices.  Picks a bright
  // instrument (glass or marimba) for the rush feel.
  const pattern = ARP_PATTERNS[Math.floor(state.prng() * ARP_PATTERNS.length)];
  const sixteenth = beatDuration() / 4;
  const steps = stepsBeats * 4;
  const instrument = state.prng() < 0.5 ? 'glass' : 'marimba';
  for (let i = 0; i < steps; i++) {
    const pIdx = i % pattern.length;
    // Each octave-length cycle steps up one real octave for a builder feel
    const octaveJump = Math.floor(i / pattern.length);
    const deg = baseDegree + pattern[pIdx];
    const t = startWhen + i * sixteenth;
    const vel = (0.38 + (pIdx === 0 ? 0.12 : 0)) * velScale;
    const semis = degreeToSemitones(deg) + octaveJump * 12;
    scheduleInstrumentNote(t, semis, 180 + state.prng() * 120, vel, instrument);
  }
}

// --- Transport ---
function beatDuration() { return 60 / state.transport.bpm; }

// Re-anchor transport.startTime when BPM changes, so the NEXT step to be
// scheduled (state.transport.beatIndex) lands on the current audio-clock
// moment instead of way in the future (chill) or way in the past (excite).
// Without this, dropping BPM can silence the melody for several seconds
// until the audio clock catches up to the newly-stretched step times.
function changeBpm(newBpm) {
  newBpm = Math.max(50, Math.min(200, newBpm));
  if (!state.ctx) { state.transport.bpm = newBpm; return; }
  const now = state.ctx.currentTime;
  state.transport.startTime = now - (state.transport.beatIndex / 4) * (60 / newBpm);
  state.transport.bpm = newBpm;
}

function startTransport() {
  if (state.transport.running) return;
  state.transport.running = true;
  state.transport.startTime = state.ctx.currentTime + 0.15;
  state.transport.beatIndex = 0;
  pickSection();
  pickNewKey();
  schedulerLoop();
}

function timeForStep(i) {
  return state.transport.startTime + (i / 4) * beatDuration(); // i in 16ths
}

function schedulerLoop() {
  if (!state.transport.running) return;
  const lookahead = 0.18; // seconds
  const now = state.ctx.currentTime;
  while (timeForStep(state.transport.beatIndex) < now + lookahead) {
    try {
      scheduleStep(state.transport.beatIndex, timeForStep(state.transport.beatIndex));
    } catch (e) {
      // Never let a single bad step kill the whole transport; log and march on.
      console.error('scheduleStep error', e);
    }
    state.transport.beatIndex++;
  }
  setTimeout(schedulerLoop, 25);
}

// Helper: fetch a full sample record for a voice slot, falling back to any
// available sample if the voice was never assigned or the stored record got
// culled.
function getVoiceSample(slot) {
  const id = slot === 'lead' ? state.melodyVoices.leadId : state.melodyVoices.counterId;
  let meta = id ? state.samples.find(s => s.id === id) : null;
  if (!meta) meta = pickSample(state.samples);
  return meta;
}

function scheduleStep(i, when) {
  const step = i % STEPS_PER_BAR;
  const bar = Math.floor(i / STEPS_PER_BAR);
  const onBeat = step % 4 === 0;
  const offbeat = step % 4 === 2;
  const sixteenth = beatDuration() / 4;

  // --- Structure / section changes ---
  if (step === 0 && bar > 0 && bar % 4 === 0) pickSection();
  if (step === 0 && bar > 0 && bar % KEY_CHANGE_EVERY_BARS === 0) {
    pickNewKey();
    state.transport.keyBar = bar;
  }

  // --- DRUMS ---
  if (state.voices.kick) {
    if (step === 0) scheduleKick(when, 0.72);
    if (step === 8 && state.intensity > 0.35) scheduleKick(when, 0.55);
    if (state.intensity > 0.75 && step === 12 && state.prng() < 0.55) scheduleKick(when, 0.42);
    if (state.excitement > 0.6 && state.prng() < 0.2) scheduleKick(when + sixteenth * 0.5, 0.3);
  }
  // Clicks, sparser than before — they were crowding the melody
  if (state.voices.click) {
    if (offbeat) scheduleClick(when, 0.25, 2800 + state.prng() * 1400);
    if (state.intensity > 0.6 && step % 4 === 3 && state.prng() < 0.5) {
      scheduleClick(when, 0.2, 3400 + state.prng() * 1200);
    }
  }
  // Shaker on off-16ths when busy — very light
  if (state.voices.shake && state.intensity > 0.55) {
    if (step % 2 === 1 && state.prng() < 0.35 + state.excitement * 0.25) {
      scheduleShake(when, 0.2);
    }
  }

  if (!state.samples.length) return;

  // --- MELODY LINE (the catchy hook) ---
  // The backing instrument plays the current melody-line on its subdivision
  // (8ths or 16ths), so there's a continuously flowing tune that changes
  // shape every 4 bars. The lead vocal locks onto this same line on its
  // downbeats so the vocal reinforces the hook instead of doing its own
  // thing.
  // Helper: given a melody-line and the current global step `i`, return
  // the scale-degree it wants to play at this step, or null if it isn't
  // firing on this step.
  function melodyDegAt(ml, offsetSteps = 0) {
    if (!ml || !ml.pattern || !ml.pattern.length) return null;
    let lineStepIdx = null;
    const off = offsetSteps || 0;
    if (ml.subdiv === 8 && (step - off + 16) % 2 === 0) {
      lineStepIdx = bar * 8 + Math.floor((step - off) / 2);
    } else if (ml.subdiv === 16) {
      lineStepIdx = bar * 16 + (step - off);
    } else {
      return null;
    }
    if (lineStepIdx < 0) return null;
    const patLen = ml.pattern.length;
    const patIdx = ((lineStepIdx % patLen) + patLen) % patLen;
    return ml.pattern[patIdx] + ml.octave * 7;
  }

  const ml = state.melodyLine;
  let melodyDegThisStep = null;
  if (ml) {
    const deg = melodyDegAt(ml);
    if (deg != null) {
      melodyDegThisStep = deg;
      state.melodyStep = deg;
      const durMs = (beatDuration() * 1000) * (ml.subdiv === 8 ? 0.48 : 0.23) * ml.gateFrac;
      const semis = degreeToSemitones(deg) - 12;
      scheduleInstrumentNote(when, semis, durMs, ml.vel);
      if (step === 0 && bar % 2 === 0) {
        scheduleInstrumentNote(when, degreeToSemitones(0) - 24, durMs * 4, ml.vel * 0.9);
      }
    }
  }

  // --- SECOND MELODY LINE (variation, same key & tempo) ---
  // About half the sections run this concurrent hook alongside the primary.
  // It's quieter, sits at a diatonic 3rd/5th/octave above, possibly starts
  // half a beat later for an echo feel.
  const ml2 = state.melodyLine2;
  if (ml2) {
    const deg2raw = melodyDegAt(ml2, ml2.phaseOffset);
    if (deg2raw != null) {
      const deg2 = deg2raw + (ml2.degShift || 0);
      const durMs = (beatDuration() * 1000) * (ml2.subdiv === 8 ? 0.4 : 0.2) * ml2.gateFrac;
      const semis = degreeToSemitones(deg2) - 12;
      scheduleInstrumentNote(when, semis, durMs, ml2.vel);
    }
  }

  // --- LEAD VOCAL: supports the melody line, fires half as often now that
  // the instrument arps carry the melodic weight.  Downbeats 1 and 3 only
  // (step 0 and 8), with a rare ornament at step 14.
  const leadMeta = getVoiceSample('lead');
  if (leadMeta) {
    const leadOn = (step === 0) || (step === 8)
      || (step === 14 && state.prng() < 0.25);
    if (leadOn) {
      const deg = melodyDegThisStep != null ? melodyDegThisStep : state.melodyStep;
      state.store.get(leadMeta.id).then(full => {
        if (!full) return;
        const durMs = 700 + state.prng() * 1100;
        const vel = (onBeat ? 0.68 : 0.48) + state.prng() * 0.08;
        playNote(full, leadMeta, when, {
          degree: deg,
          vel,
          durationMs: durMs,
          layer: 'perf',
          panOverride: Math.sin(bar * 0.6) * 0.35 + (state.prng() * 2 - 1) * 0.15,
        });
      });
    }
  }

  // --- COUNTER VOICE: halved.  Fires on beat-2 (step 4) and beat-4 (step
  // 12) only, with an occasional offbeat flourish.
  const counterMeta = getVoiceSample('counter');
  if (counterMeta) {
    const counterOn = (step === 4) || (step === 12)
      || ((step === 6 || step === 14) && state.prng() < 0.25);
    if (counterOn) {
      const deg = state.melodyStep + state.melodyVoices.counterOffset
                + (state.prng() < 0.2 ? (state.prng() < 0.5 ? -2 : 2) : 0);
      state.store.get(counterMeta.id).then(full => {
        if (!full) return;
        const durMs = 380 + state.prng() * 520;
        const vel = (offbeat ? 0.48 : 0.4) + state.prng() * 0.06;
        playNote(full, counterMeta, when, {
          degree: deg,
          vel,
          durationMs: durMs,
          layer: 'perf',
          panOverride: -Math.sin(bar * 0.6) * 0.5 + (state.prng() * 2 - 1) * 0.15,
        });
      });
    }
  }

  // The 16th-fill layer is redundant now that three arp voices are always
  // running. Keep a very sparse one for variety — random short pops that
  // sit between the arps without fighting them.
  // Lead/counter now fire on a reduced set of steps (0,4,8,12 plus rare
  // ornaments); the fill layer only lights up on the rest.
  const isLeadStep = step === 0 || step === 8 || step === 14;
  const isCounterStep = step === 4 || step === 12 || step === 6;
  if (!isLeadStep && !isCounterStep && state.prng() < 0.06) {
    const pool = pickSamplesForMood(state.mood);
    const fillMeta = pool[Math.floor(state.prng() * pool.length)];
    if (fillMeta) {
      const deg = state.melodyStep + (state.prng() < 0.5 ? 0 : (state.prng() < 0.5 ? -2 : 2));
      state.store.get(fillMeta.id).then(full => {
        if (!full) return;
        const durMs = 90 + state.prng() * 140;
        const vel = 0.3 + state.prng() * 0.15;
        playNote(full, fillMeta, when, {
          degree: deg, vel, durationMs: durMs, layer: 'perf',
          panOverride: (state.prng() * 2 - 1) * 0.85,
        });
      });
    }
  }

  // --- CONTINUOUS ARP VOICES ---
  // Three always-on arpeggiators with independent patterns + subdivisions.
  // Polyrhythm arises naturally: a 4-step pattern and a 6-step pattern
  // cycling at 16ths realign every 12 steps, so the hook keeps reshuffling.
  tickArps(i, when);

  // --- AMBIENT drone: root + fifth, sparse, kept quiet ---
  if (step === 0 && bar % 4 === 0) {
    const m = getVoiceSample('lead');
    if (m) {
      state.store.get(m.id).then(full => {
        if (!full) return;
        const st = state.prng() < 0.6 ? -12 : -5; // root or fifth below
        triggerGrain(full, {
          offsetMs: state.prng() * Math.max(0, m.durationMs - 1600),
          durationMs: 1600 + state.prng() * 1800,
          rate: rateForSemitones(st),
          pan: (state.prng() * 2 - 1) * 0.7,
          gain: 0.14 + state.prng() * 0.08,
          mutation: Math.max(m.mutationLevel, 0.3),
          layer: 'ambient', filterType: 'lowpass',
          filterHz: 520 + (1 - state.mouse.y) * 600,
          filterQ: 0.6,
          revSend: 0.85, delSend: 0.15,
          when,
        });
      });
    }
  }
}

async function autoRecord() {
  if (state.recording) return;
  if (state.samples.length >= 40) return;
  if (!micStream) return;
  await recordBreath(2000 + state.prng() * 2000);
}

// Excite: persistently speed up + louden + make busier
function excite() {
  changeBpm(state.transport.bpm + 6);
  state.intensityBias = Math.min(0.25, state.intensityBias + 0.08);
  state.intensity = Math.max(0.1, Math.min(1, state.intensity + 0.18));
  state.excitement = Math.min(1, state.excitement + 0.55);
  // Reshuffle the three arp voices AND pick a new melody-line hook so the
  // whole song transforms when you press excite.
  pickMelodyLine();
  pickArps();
  const nextBeatWhen = state.ctx ? state.ctx.currentTime + 0.05 : 0;
  if (state.samples.length && state.ctx) scheduleArpeggio(nextBeatWhen, 8, 0, 1);
}
// Chill: slow down + soften
function chill() {
  changeBpm(state.transport.bpm - 6);
  state.intensityBias = Math.max(-0.3, state.intensityBias - 0.1);
  state.intensity = Math.max(0.1, state.intensity - 0.2);
  state.excitement = Math.max(0, state.excitement - 0.4);
}
// ======== INPUT (mouse modulates ongoing parameters) ========
function initInput() {
  const cv = document.getElementById('viz');
  const onMove = (cx, cy) => {
    state.mouse.x = cx / window.innerWidth;
    state.mouse.y = cy / window.innerHeight;
    state.mouse.lastMoveAt = Date.now();
  };
  cv.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
  cv.addEventListener('touchmove', (e) => {
    if (e.touches.length) onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  cv.addEventListener('touchstart', (e) => {
    if (e.touches.length) onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  // continuously drive the perf / ambient filter cutoffs + drum bus from mouse Y + excitement
  const driveFilter = () => {
    if (state.ctx) {
      const t = state.ctx.currentTime;
      if (state.perfFilter) {
        // Keep melody bright by default; mouse Y sweeps from smoky → open
        const base = 1800 + (1 - state.mouse.y) * 10000;
        const target = base * (0.9 + state.excitement * 0.3);
        try {
          state.perfFilter.frequency.setTargetAtTime(target, t, 0.1);
          state.perfFilter.Q.setTargetAtTime(0.7 + state.mouse.y * 2.5, t, 0.15);
        } catch (e) {}
      }
      if (state.ambFilter) {
        const amb = 300 + (1 - state.mouse.y) * 1400;
        try { state.ambFilter.frequency.setTargetAtTime(amb, t, 0.25); } catch (e) {}
      }
      if (state.drumBus) {
        const drumTarget = 0.28 + state.intensity * 0.3 + state.excitement * 0.2;
        try { state.drumBus.gain.setTargetAtTime(drumTarget, t, 0.3); } catch (e) {}
      }
      if (state.padBus) {
        // Max 0.08 no matter what — rain never dominates.
        const padTarget = 0.035 + (1 - state.intensity) * 0.04;
        try { state.padBus.gain.setTargetAtTime(padTarget, t, 1.0); } catch (e) {}
      }
    }
    requestAnimationFrame(driveFilter);
  };
  requestAnimationFrame(driveFilter);
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
  // Radius reacts strongly to intensity + excitement so chill pulls the
  // circle in and excite pushes it out.  Smooth toward the target so
  // presses feel like the instrument inhales / exhales instead of snapping.
  const targetScale = 0.55 + state.intensity * 0.7 + state.excitement * 0.55;
  viz.radiusScale = viz.radiusScale != null
    ? viz.radiusScale + (targetScale - viz.radiusScale) * Math.min(1, dt * 3)
    : targetScale;
  const r = baseR * viz.radiusScale * (0.85 + breath * 0.18 + level * 0.5);
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
  // Reveal the RETURN HOME row only when we're visiting someone else's
  // instrument. On the home instrument, it stays hidden.
  const homeRow = el('r-home-row');
  if (homeRow) {
    const home = homeGenomeId();
    if (home && home !== g.id) {
      homeRow.classList.remove('hidden');
      const homeLabel = el('r-home');
      if (homeLabel) homeLabel.textContent = home.slice(0, 8);
    } else {
      homeRow.classList.add('hidden');
    }
  }
  el('r-gen').textContent = g.generation;
  el('r-mood').textContent = state.mood;
  el('r-state').textContent = state.started ? 'playing' : 'paused';
  el('r-samples').textContent = state.samples.length;
  el('r-wakes').textContent = g.activationCount;
  el('r-age').textContent = fmtTime(Date.now() - g.birthday);
  const now = Date.now();
  let oldest = 0;
  for (const s of state.samples) { const a = now - s.recordedAt; if (a > oldest) oldest = a; }
  el('r-oldest').textContent = state.samples.length ? fmtTime(oldest) : '—';
  el('r-nextwake').textContent = state.intensity.toFixed(2) + (state.excitement > 0.05 ? ' ✦' : '');
  const bpmEl = el('r-bpm'); if (bpmEl) bpmEl.textContent = Math.round(state.transport.bpm) + ' bpm';
  const keyEl = el('r-key'); if (keyEl) keyEl.textContent = keyLabel();
  const barEl = el('r-bar'); if (barEl) {
    const bar = Math.floor(state.transport.beatIndex / STEPS_PER_BAR);
    const step = state.transport.beatIndex % STEPS_PER_BAR;
    barEl.textContent = bar + ':' + String(step).padStart(2, '0');
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
    try { await recordBreath(3000); } catch (e) { console.error(e); }
    btn.classList.remove('recording');
    btn.textContent = '◉ record breath';
  });
  const wakeBtn = el('btn-wake'); if (wakeBtn) wakeBtn.addEventListener('click', () => excite());
  const sleepBtn = el('btn-sleep'); if (sleepBtn) sleepBtn.addEventListener('click', () => chill());
  el('btn-evolve').addEventListener('click', () => evolveTick());
  el('vol').addEventListener('input', (e) => {
    if (state.master) state.master.gain.value = parseFloat(e.target.value);
  });
  // Click the genome row to copy the full id — used for moving an instrument
  // between devices or inviting someone to meet yours.
  const genomeRow = el('r-genome-row');
  if (genomeRow) {
    genomeRow.addEventListener('click', async () => {
      if (!state.genome) return;
      try {
        await navigator.clipboard.writeText(state.genome.id);
        genomeRow.querySelector('#r-genome').textContent = 'copied';
        setTimeout(() => { /* next updateReadouts restores the display */ }, 900);
      } catch (e) { console.warn('clipboard failed', e); }
    });
  }
  // Share-my-breaths toggle: affects new recordings going forward.
  const togShare = el('tog-share');
  if (togShare) {
    togShare.checked = !!state.shareMyBreaths;
    togShare.addEventListener('change', (e) => {
      state.shareMyBreaths = !!e.target.checked;
      localStorage.setItem(LS_SHARE_BREATHS, state.shareMyBreaths ? '1' : '0');
    });
  }
  // Include-shared-pool toggle: re-pulls samples from cloud with the new flag.
  const togPool = el('tog-pool');
  if (togPool) {
    togPool.checked = !!state.includeSharedPool;
    togPool.addEventListener('change', (e) => {
      state.includeSharedPool = !!e.target.checked;
      localStorage.setItem(LS_INCLUDE_SHARED, state.includeSharedPool ? '1' : '0');
      if (state.started) syncCloudSamples().catch(() => {});
    });
  }
  // Return home: swap localStorage back to the home genome id.  Used when
  // the user has imported someone else's instrument and wants to come back
  // to their own.  Home is set once on first boot and never overwritten.
  const homeRow = el('r-home-row');
  if (homeRow) {
    homeRow.addEventListener('click', async () => {
      const home = homeGenomeId();
      if (!home) return;
      if (!confirm('Return to your home instrument (' + home.slice(0, 8) + '…)?\n\nThe current sample cache will be cleared.')) return;
      const placeholder = {
        id: home,
        seed: (Math.random() * 4294967296) >>> 0,
        birthday: Date.now(),
        params: state.genome ? state.genome.params : {},
        generation: 0,
        activationCount: 0,
      };
      localStorage.setItem(LS_GENOME, JSON.stringify(placeholder));
      if (state.store) { try { await state.store.clear(); } catch (e) {} }
      location.reload();
    });
  }
  // Import instrument: paste a UUID and press Enter. The local IDB cache is
  // cleared so old samples don't mix with the new pool; the page reloads
  // and boot pulls the freshly-referenced instrument from the cloud.
  const importInput = el('r-import-input');
  if (importInput) {
    importInput.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const raw = (importInput.value || '').trim();
      if (!raw) return;
      const uuidLike = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (!uuidLike.test(raw)) {
        importInput.style.borderColor = 'var(--warn)';
        importInput.value = '';
        importInput.placeholder = 'not a valid id';
        setTimeout(() => { importInput.placeholder = 'paste id + enter'; importInput.style.borderColor = ''; }, 1600);
        return;
      }
      const home = homeGenomeId();
      const note = home && raw !== home ? ' (↶ RETURN HOME takes you back to your original.)' : '';
      if (!confirm('Visit instrument ' + raw.slice(0, 8) + '…?\n\nYour local sample cache will be cleared.' + note)) return;
      try {
        // Write a placeholder genome record so boot knows the id it should
        // pull. Params/generation get overwritten by syncCloudGenome on boot.
        const placeholder = {
          id: raw,
          seed: (Math.random() * 4294967296) >>> 0,
          birthday: Date.now(),
          params: state.genome ? state.genome.params : {},
          generation: 0,
          activationCount: 0,
        };
        localStorage.setItem(LS_GENOME, JSON.stringify(placeholder));
        // Wipe the local sample cache so old samples don't leak into the new instrument.
        if (state.store) { try { await state.store.clear(); } catch (e) {} }
        location.reload();
      } catch (e) {
        console.error('import failed', e);
        alert('Import failed: ' + e.message);
      }
    });
  }
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

async function syncCloudGenome() {
  if (!cloudReady) return;
  const remote = await pullGenome(state.genome.id).catch(() => null);
  if (remote) {
    // Cloud wins — apply its values over the local cache
    state.genome = {
      id: remote.id,
      seed: Number(remote.seed),
      birthday: new Date(remote.birthday).getTime(),
      params: remote.params,
      generation: remote.generation,
      activationCount: remote.activation_count,
    };
    saveGenome();
  } else {
    // First time this instrument has touched the cloud — push the local one up
    pushGenome(state.genome).catch(() => {});
  }
}

// Upgrade legacy samples that were recorded before pitch detection existed.
// Runs in the background one sample at a time so it never blocks anything.
async function upgradeSamplesWithPitch() {
  const needing = state.samples.filter(m => !m.detectedHz);
  for (const meta of needing) {
    try {
      const full = await state.store.get(meta.id);
      if (!full || !full.pcm) continue;
      const hz = detectHz(full.pcm, full.sampleRate);
      if (!hz) continue;
      meta.detectedHz = hz;
      full.detectedHz = hz;
      await state.store.update(meta.id, { detectedHz: hz }).catch(() => {});
      if (cloudReady && meta.storagePath) {
        updateSample(meta.id, { detected_hz: hz }).catch(() => {});
      }
      // Yield to the event loop so rapid scheduler ticks aren't delayed
      await new Promise(r => setTimeout(r, 25));
    } catch (e) { console.warn('pitch upgrade failed for', meta.id, e); }
  }
}

async function syncCloudSamples() {
  if (!cloudReady || !state.ctx) return;
  const remote = await pullSamples(state.genome.id, { includeShared: state.includeSharedPool }).catch(() => []);
  const localIds = new Set(state.samples.map(s => s.id));
  let added = 0;
  for (const rs of remote) {
    if (localIds.has(rs.id)) continue;
    try {
      const blob = await fetchSampleBlob(rs.storage_path);
      if (!blob) continue;
      const ab = await blob.arrayBuffer();
      const audioBuf = await state.ctx.decodeAudioData(ab).catch(() => null);
      if (!audioBuf) continue;
      const pcm = audioBuf.getChannelData(0).slice();
      // Cloud samples uploaded by older builds aren't peak-normalised.
      // Apply the same 0.8 ceiling so remote + local samples behave alike.
      normalizePcmInPlace(pcm, 0.65);
      // Use the pitch the sample row already carries; otherwise run YIN now
      // and push the result back so no one else has to redo the work.
      let detectedHz = rs.detected_hz != null ? Number(rs.detected_hz) : null;
      if (!detectedHz) {
        detectedHz = detectHz(pcm, audioBuf.sampleRate);
        if (detectedHz) {
          updateSample(rs.id, { detected_hz: detectedHz }).catch(() => {});
        }
      }
      const record = {
        id: rs.id, pcm, sampleRate: audioBuf.sampleRate,
        recordedAt: new Date(rs.recorded_at).getTime(),
        lastPlayedAt: rs.last_played_at ? new Date(rs.last_played_at).getTime() : 0,
        generation: rs.generation,
        mutationLevel: Number(rs.mutation_level) || 0,
        source: rs.source,
        survivalScore: Number(rs.survival_score) || 1,
        parentId: rs.parent_id,
        storagePath: rs.storage_path,
        shared: rs.shared,
        genomeId: rs.genome_id,
        detectedHz,
      };
      await state.store.add(record);
      const meta = sampleMeta(record);
      state.samples.push(meta);
      added++;
    } catch (e) { console.warn('sample sync failed for', rs.id, e); }
  }
  if (added) console.log('[cloud] pulled', added, 'samples');
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
  // Cloud genome sync happens before audio start; sample sync happens after
  // initAudio (decodeAudioData needs a context).
  await syncCloudGenome();
  const status = document.getElementById('status');
  const kick = async () => {
    if (state.started) return;
    state.started = true;
    status.textContent = 'requesting mic…';
    try {
      await initAudio();
      await ensureMic();
      startTransport();
      startRainPad();
      // Pull cloud samples into IDB + state in the background, then run
      // pitch detection for any sample that doesn't already have it.
      syncCloudSamples()
        .then(() => upgradeSamplesWithPitch())
        .catch(e => console.warn('sample sync error', e));
      status.textContent = state.samples.length
        ? 'playing — move mouse to modulate · ✦ excite · ~ chill'
        : 'record a breath (◉) to give it material — melody awaits samples';
      setTimeout(() => status.classList.add('hidden'), 2600);
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
