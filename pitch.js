// YIN pitch detection — https://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf
// Takes a Float32Array of mono PCM and returns the estimated fundamental
// frequency in Hz, or null if the input isn't tonal enough to trust.

const DEFAULT_MIN_HZ = 70;   // below a male bass voice
const DEFAULT_MAX_HZ = 900;  // above a soprano; breaths won't exceed this
const DEFAULT_THRESHOLD = 0.15;

// Pick a ~2048-sample window from the stable middle of the recording so we
// skip the mic-open transient at the start and the release at the end.
function extractAnalysisWindow(pcm) {
  const winSize = Math.min(2048, pcm.length);
  // Prefer the middle third of the recording
  const startOffset = Math.max(
    0,
    Math.floor(pcm.length * 0.33) - Math.floor(winSize / 2)
  );
  return pcm.subarray(startOffset, startOffset + winSize);
}

// Returns { hz, confidence } or null.
export function estimatePitchYIN(pcm, sampleRate, opts = {}) {
  if (!pcm || !pcm.length) return null;
  const minHz = opts.minHz || DEFAULT_MIN_HZ;
  const maxHz = opts.maxHz || DEFAULT_MAX_HZ;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;

  const frame = extractAnalysisWindow(pcm);
  const W = frame.length;

  // Check for silence / near-silence — YIN will return garbage on a flat
  // signal so we bail fast.
  let rms = 0;
  for (let i = 0; i < W; i++) rms += frame[i] * frame[i];
  rms = Math.sqrt(rms / W);
  if (rms < 0.003) return null;

  const maxTau = Math.min(Math.floor(W / 2), Math.floor(sampleRate / minHz));
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxTau <= minTau + 2) return null;

  // Step 1: difference function d[tau] = sum (x[i] - x[i+tau])^2
  const diff = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    const limit = W - tau;
    for (let i = 0; i < limit; i++) {
      const dx = frame[i] - frame[i + tau];
      sum += dx * dx;
    }
    diff[tau] = sum;
  }

  // Step 2: cumulative mean normalized difference function
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  // Step 3: absolute threshold — find smallest tau below threshold, then
  // walk down to its local minimum.
  let tauEstimate = -1;
  for (let tau = minTau; tau <= maxTau; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate < 0) return null;

  // Step 4: parabolic interpolation for sub-sample accuracy
  let betterTau = tauEstimate;
  if (tauEstimate > 0 && tauEstimate < maxTau) {
    const y0 = cmnd[tauEstimate - 1];
    const y1 = cmnd[tauEstimate];
    const y2 = cmnd[tauEstimate + 1];
    const denom = 2 * (2 * y1 - y2 - y0);
    if (denom !== 0) {
      const offset = (y2 - y0) / denom;
      if (Math.abs(offset) < 1) betterTau = tauEstimate + offset;
    }
  }

  const hz = sampleRate / betterTau;
  if (!isFinite(hz) || hz < minHz || hz > maxHz) return null;

  return { hz, confidence: 1 - cmnd[tauEstimate] };
}

// Convenience helper — just returns the Hz (or null).
export function detectHz(pcm, sampleRate) {
  const r = estimatePitchYIN(pcm, sampleRate);
  return r ? r.hz : null;
}

// Reference pitch for "degree 0" targets. C4 = 261.63 Hz.
export const REFERENCE_HZ = 261.63;

// Compute a playback rate that lands `sampleHz` at `targetHz` — but chooses
// the nearest octave of the target so we don't chipmunk a low sample up to
// a high register (the result would be unmusical and very short).
export function rateForTarget(sampleHz, targetHz, octaveBias = 0) {
  if (!sampleHz || sampleHz <= 0) return 1;
  const biased = targetHz * Math.pow(2, octaveBias);
  let rate = biased / sampleHz;
  // Keep rate within [1/√2, √2] — i.e. pick the octave of the target that
  // is closest in pitch to the sample. Result is always the correct pitch
  // class, never more than half an octave from the sample's natural pitch.
  const UP = Math.SQRT2;
  const DOWN = 1 / Math.SQRT2;
  let guard = 0;
  while (rate > UP && guard++ < 8) rate /= 2;
  while (rate < DOWN && guard++ < 8) rate *= 2;
  return rate;
}
