// A JavaScript port of earshot's drone detector (github.com/lizTheDeveloper/earshot, src/earshot/detect.py),
// so a phone can listen in the browser. Same method and constants; it takes 16 kHz mono float samples.
// Only events leave this module: a time span, a pitch, a confidence. No audio is kept beyond one 1 s frame.

export const SR = 16000;
const FRAME_S = 1.0, HOP_S = 0.25;
const F_LO = 40, F_HI = 4200;
const F0_LO = 80, F0_HI = 600, F0_STEP = 0.25;
const MAX_HARM = 20, HIT_DB = 6, MIN_HITS = 4, MIN_SCORE = 12;
const TRACK_JUMP = 0.07, GAP_S = 1.5, MIN_EVENT_S = 5.0, MIN_COVERAGE = 0.6, BACKGROUND_S = 120;
const MIN_WOBBLE = 0.0015, FULL_WOBBLE = 0.004, MIN_JITTER = 0.002;
export const CONFIDENCE = 0.5;
const NFFT = 16384; // the 1 s frame (16000 samples) zero-padded to a power of two

// -- small numeric helpers -------------------------------------------------------------------------
function fftMag(re) { // in-place radix-2 FFT of a real signal (length NFFT); returns |X| for bins 0..NFFT/2
  const n = re.length, im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const out = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
  return out;
}
function medianFilter(x, size) { // like scipy median_filter(mode="nearest")
  const h = size >> 1, n = x.length, out = new Float64Array(n), w = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    for (let k = -h; k <= h; k++) w[k + h] = x[Math.min(n - 1, Math.max(0, i + k))];
    w.sort();
    out[i] = w[h];
  }
  return out;
}
function max3(x) {
  const n = x.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(x[Math.max(0, i - 1)], x[i], x[Math.min(n - 1, i + 1)]);
  return out;
}
const median = (a) => { const s = [...a].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function polyfit2Resid(t, y) { // residuals of a least-squares quadratic fit
  const n = t.length, t0 = t.reduce((a, b) => a + b, 0) / n;
  const x = t.map((v) => v - t0);
  let S = [0, 0, 0, 0, 0], B = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    let p = 1;
    for (let k = 0; k < 5; k++) { S[k] += p; if (k < 3) B[k] += p * y[i]; p *= x[i]; }
  }
  const A = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  // solve A c = B (Gaussian elimination)
  const M = A.map((r, i) => [...r, B[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-18) return y.map((v) => v - y.reduce((a, b) => a + b, 0) / n);
    for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
  }
  const co = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  return y.map((v, i) => v - (co[0] + co[1] * x[i] + co[2] * x[i] * x[i]));
}
const std = (a) => { const m = a.reduce((p, q) => p + q, 0) / a.length; return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length); };
const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function related(a, b) {
  const r = Math.max(a, b) / Math.min(a, b);
  return [1, 2, 3].some((m) => Math.abs(r - m) / m < (m === 1 ? 0.08 : 0.03));
}

export class Detector {
  constructor(threshold = CONFIDENCE) {
    this.threshold = threshold;
    this.frame = Math.round(FRAME_S * SR);
    this.hop = Math.round(HOP_S * SR);
    this.win = Float64Array.from({ length: this.frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.frame - 1)));
    this.df = SR / NFFT;
    this.lo = Math.ceil(F_LO / this.df);
    this.hi = Math.floor(F_HI / this.df);
    this.nb = this.hi - this.lo + 1;
    this.f0s = [];
    for (let f = F0_LO; f <= F0_HI + 1e-9; f += F0_STEP) this.f0s.push(f);
    this.K = this.f0s.map((f) => Math.min(MAX_HARM, Math.floor(4000 / f)));
    this.hidx = this.f0s.map((f) => Array.from({ length: MAX_HARM }, (_, k) =>
      clip(Math.round(((k + 1) * f) / this.df) - this.lo, 0, this.nb - 1)));
    this.bg = new Float64Array(this.nb);
    this.alpha = HOP_S / BACKGROUND_S;
    this.buf = new Float32Array(0);
    this.n = 0;
    this.tracks = [];
    this.pending = [];
    this.gap = Math.round(GAP_S / HOP_S);
  }

  /** Feed any number of 16 kHz samples; returns finished events. */
  feed(x) {
    const out = [];
    const all = new Float32Array(this.buf.length + x.length);
    all.set(this.buf); all.set(x, this.buf.length);
    let off = 0;
    while (all.length - off >= this.frame) {
      out.push(...this._frame(all.subarray(off, off + this.frame)));
      off += this.hop;
    }
    this.buf = all.slice(off);
    return out;
  }

  flush() {
    for (const tr of this.tracks) this._hold(this._finish(tr));
    const out = this.pending;
    this.pending = []; this.tracks = []; this.buf = new Float32Array(0);
    return out;
  }

  _frame(x) {
    const t = (this.n * this.hop + this.frame / 2) / SR;
    const re = new Float64Array(NFFT);
    for (let i = 0; i < this.frame; i++) re[i] = x[i] * this.win[i];
    const mag = fftMag(re);
    const X = mag.subarray(this.lo, this.hi + 1);
    let power = 0;
    for (let i = 0; i < this.nb; i++) { const f = (this.lo + i) * this.df; if (f >= 80 && f <= 4000) power += X[i] * X[i]; }
    let w2 = 0;
    for (let i = 0; i < this.frame; i++) w2 += this.win[i] ** 2;
    const level = 10 * Math.log10((2 * power) / w2 / this.frame + 1e-20);
    const L = Float64Array.from(X, (v) => 20 * Math.log10(v + 1e-12));
    const med = medianFilter(L, 41);
    const Wd = new Float64Array(this.nb);
    for (let i = 0; i < this.nb; i++) {
      const W = L[i] - med[i];
      this.bg[i] += this.alpha * (W - this.bg[i]);
      Wd[i] = W - Math.max(this.bg[i], 0);
    }
    const cands = this._candidates(Wd, L);
    this.n++;
    return this._track(t, cands, level);
  }

  _candidates(W, L) {
    const W3 = max3(W);
    const nf = this.f0s.length, score = new Float64Array(nf), span = new Int32Array(nf), hits = new Int32Array(nf);
    for (let j = 0; j < nf; j++) {
      const K = this.K[j], idx = this.hidx[j];
      let cs = 0, best = -Infinity, bspan = 0;
      for (let k = 0; k < K; k++) {
        cs += clip(W3[idx[k]] - HIT_DB, -6, 14);
        if (k >= MIN_HITS - 1 && cs > best) { best = cs; bspan = k + 1; }
      }
      score[j] = best; span[j] = bspan;
      let h = 0;
      for (let k = 0; k < bspan; k++) if (W3[idx[k]] >= HIT_DB) h++;
      hits[j] = h;
    }
    const order = Array.from({ length: nf }, (_, j) => j).sort((a, b) => score[b] - score[a]).slice(0, 400);
    const chosen = [];
    for (const j of order) {
      if (score[j] < MIN_SCORE || chosen.length === 3) break;
      if (hits[j] < MIN_HITS) continue;
      const f0 = this.f0s[j];
      if (chosen.some((c) => related(f0, c.f0))) continue;
      const hitK = [];
      for (let k = 0; k < span[j]; k++) if (W3[this.hidx[j][k]] >= HIT_DB) hitK.push(k + 1);
      const f0r = this._refine(f0, L, hitK);
      chosen.push({ f0: f0r, score: score[j], hits: hits[j], half: this._finerComb(f0r, W3), span: span[j] });
    }
    return chosen;
  }

  _finerComb(f0, W3) {
    let best = 0;
    for (let n = 2; n <= Math.floor(f0 / 20); n++) {
      const ks = [];
      for (let k = 1; k <= Math.floor((1500 * n) / f0); k++) if (k % n !== 0) ks.push(k);
      if (ks.length < 4) continue;
      let hit = 0, cnt = 0;
      for (const k of ks) {
        const i = Math.round((k * f0) / n / this.df) - this.lo;
        if (i < 0 || i >= W3.length) continue;
        cnt++; if (W3[i] >= HIT_DB) hit++;
      }
      if (cnt) best = Math.max(best, hit / cnt);
    }
    return best;
  }

  _refine(f0, L, hitK) {
    const est = [];
    for (const k of hitK) {
      const c = Math.round((k * f0) / this.df) - this.lo;
      const lo = Math.max(c - 2, 1), hi = Math.min(c + 3, L.length - 1);
      if (hi - lo < 3) continue;
      let p = lo;
      for (let i = lo; i < hi; i++) if (L[i] > L[p]) p = i;
      if (p <= 0 || p >= L.length - 1) continue;
      const a = L[p - 1], b = L[p], cc = L[p + 1], den = a - 2 * b + cc;
      const d = den !== 0 ? (0.5 * (a - cc)) / den : 0;
      est.push(((this.lo + p + d) * this.df) / k);
    }
    return est.length ? median(est) : f0;
  }

  _track(t, cands, level) {
    const used = new Set();
    for (const c of cands) {
      let best = null, bd = TRACK_JUMP;
      for (const tr of this.tracks) {
        if (used.has(tr)) continue;
        const d = Math.abs(c.f0 - tr.f0.at(-1)) / tr.f0.at(-1);
        if (d <= bd) { best = tr; bd = d; }
      }
      if (!best) { best = { t: [], f0: [], hits: [], score: [], half: [], span: [], level: [], last: 0 }; this.tracks.push(best); }
      used.add(best);
      best.t.push(t); best.f0.push(c.f0); best.hits.push(c.hits); best.score.push(c.score);
      best.half.push(c.half); best.span.push(c.span); best.level.push(level); best.last = this.n;
    }
    const alive = [];
    for (const tr of this.tracks) {
      if (this.n - tr.last > this.gap) this._hold(this._finish(tr));
      else alive.push(tr);
    }
    this.tracks = alive;
    return this._release(t);
  }

  /** The best event still in progress: a sound that already passes every check but hasn't stopped (a drone
   * hovering overhead for minutes would otherwise never be reported until it left). */
  ongoing() {
    let best = null;
    for (const tr of this.tracks) {
      const e = this._finish(tr);
      if (e && (!best || e.confidence > best.confidence)) best = e;
    }
    return best;
  }

  _hold(e) {
    if (!e) return;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (e.start <= p.end + GAP_S && p.start <= e.end + GAP_S) {
        const best = e.confidence > p.confidence ? e : p;
        this.pending.splice(i, 1);
        return this._hold({ start: Math.min(e.start, p.start), end: Math.max(e.end, p.end), f0: best.f0,
          harmonics: Math.max(e.harmonics, p.harmonics), level: Math.max(e.level, p.level), wobble: best.wobble,
          confidence: Math.max(e.confidence, p.confidence) });
      }
    }
    this.pending.push(e);
  }

  _release(t) {
    const first = this.tracks.length ? Math.min(...this.tracks.map((tr) => tr.t[0])) : Infinity;
    const ready = this.pending.filter((p) => p.end + GAP_S < first - FRAME_S / 2 && p.end + GAP_S < t);
    this.pending = this.pending.filter((p) => !ready.includes(p));
    return ready;
  }

  _finish(tr) {
    const tt = tr.t, n = tt.length;
    if (!n || tt[n - 1] - tt[0] + HOP_S < MIN_EVENT_S) return null;
    if (n < (MIN_COVERAGE * (tt[n - 1] - tt[0] + HOP_S)) / HOP_S) return null;
    const lf = tr.f0.map(Math.log);
    const wobble = n >= 4 ? std(polyfit2Resid(tt, lf)) : std(lf);
    const hits = median(tr.hits);
    const K = Math.max(MIN_HITS, median(tr.span));
    const strength = 0.5 * Math.min(1, hits / K / 0.6) + 0.5 * Math.min(1, median(tr.score) / (8 * K));
    const steady = clip((wobble - MIN_WOBBLE) / (FULL_WOBBLE - MIN_WOBBLE), 0, 1);
    const steps = [];
    for (let i = 1; i < n; i++) if (tt[i] - tt[i - 1] <= HOP_S * 1.5) steps.push(Math.abs(lf[i] - lf[i - 1]));
    const jitter = steps.length ? median(steps) : 0;
    if (jitter < MIN_JITTER) return null;
    const engine = clip((0.7 - median(tr.half)) / 0.3, 0, 1);
    const dur = tt[n - 1] - tt[0] + HOP_S;
    const lasting = 0.7 + 0.3 * Math.min(1, (dur - MIN_EVENT_S) / 5);
    const conf = clip(0.4 + 0.6 * strength, 0, 1) * steady * engine * lasting;
    if (conf < this.threshold) return null;
    return { start: tt[0] - FRAME_S / 2, end: tt[n - 1] + FRAME_S / 2, f0: median(tr.f0), harmonics: Math.round(hits),
      level: Math.max(...tr.level), wobble, confidence: conf };
  }
}

/** Streaming resampler to 16 kHz for browsers that won't open a 16 kHz audio context: a short moving average
 * (a crude low-pass, enough below 4.2 kHz), then picks at the 16 kHz spacing. */
export function resampler(fromSr) {
  if (fromSr === SR) return (x) => x;
  const step = fromSr / SR; let pos = 0, prev = new Float32Array(0);
  return (x) => {
    const all = new Float32Array(prev.length + x.length); all.set(prev); all.set(x, prev.length);
    const out = []; const half = Math.max(1, Math.floor(step / 2));
    while (pos + half < all.length) {
      const i = Math.floor(pos); let s = 0, n = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(all.length - 1, i + half); k++) { s += all[k]; n++; }
      out.push(s / n); pos += step;
    }
    const keep = Math.max(0, Math.floor(pos) - half);
    prev = all.slice(keep); pos -= keep;
    return Float32Array.from(out);
  };
}

