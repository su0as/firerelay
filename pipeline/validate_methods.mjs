// FireRelay pipeline step 2: calibrate, validate and publish.
// Reads sparse monthly grids from aggregate.mjs and writes static web data:
//   web/data/tiles/<tr>_<tc>.bin  (5x5 deg tiles of 0.25 deg cells, gzip'd binary, see TILE FORMAT)
//   web/data/meta.json            (eras, availability, uncertainty table, global numbers)
//   web/data/validation.json      (hold-out skill scores and chart series for the Method page)
//
// HARMONIZATION (target unit = NOAA-20 VIIRS 375 m equivalent detections, nominal+high confidence, vegetation fires)
//   NOAA-20 era (from N20_START): observed NOAA-20 counts, no model.
//   S-NPP era (SNPP_START .. N20_START-1): rS[c] * S-NPP, rS = shrunk ratio-of-sums NOAA-20/S-NPP in their overlap.
//   MODIS era (before SNPP_START): rS[c] * mean over available satellites s in {Terra, Aqua} of k_s[c] * MODIS_s,
//     k_s = shrunk ratio-of-sums S-NPP/MODIS_s over the calibration window (both MODIS platforms in nominal orbit).
//   Shrinkage (empirical Bayes, gamma-Poisson style): k_c = (sum V_c + lambda * k_parent) / (sum M_c + lambda),
//     parent chain 0.25 deg cell -> 1 deg block -> 5 deg tile -> global.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [aggDirs, webDir] = [process.argv[2].split(','), process.argv[3]];
const OUT = process.argv[4];
const Y0 = 2001, NY = 26, NM = NY * 12;               // Jan 2001 .. Dec 2026
const SER = ['terra', 'aqua', 'snpp', 'noaa20'];
const S = { terra: 0, aqua: 1, snpp: 2, noaa20: 3 };
const mi = (y, m) => (y - Y0) * 12 + (m - 1);
const LAMBDA = +(process.env.LAMBDA || 30);

// ---------- load ----------
const cells = new Map(); // cell025 -> Uint32Array(NM*4)  [series][month]
function cellArr(c) { let a = cells.get(c); if (!a) { a = new Uint32Array(NM * 4); cells.set(c, a); } return a; }
for (const dir of aggDirs) {
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^m_(terra|aqua|snpp|noaa20)_(\d{4})\.bin$/); if (!m) continue;
    const s = S[m[1]], y = +m[2]; if (y < Y0 || y >= Y0 + NY) continue;
    const b = fs.readFileSync(path.join(dir, f));
    for (let o = 0; o < b.length; o += 9) {
      const c = b.readUInt32LE(o), mo = b.readUInt8(o + 4), n = b.readUInt32LE(o + 5);
      cellArr(c)[s * NM + (y - Y0) * 12 + mo] += n;
    }
  }
}
// ---------- near-real-time months: remove static (non-vegetation) sources per cell ----------
// FIRMS NRT files have no 'type' flag. For each 0.25 deg cell we take the share of NOAA-20 detections that the
// 2025 standard archive flagged as type 1-3 (volcano, static land source, offshore) and scale NRT counts by (1 - share).
const nonvegC = new Map(), nonvegB = new Map(), vegC = new Map(), vegB = new Map();
const NRT_NOTE = { cellsWithStaticShare: 0 };
if (process.env.NONVEG_DIR) {
  const b = fs.readFileSync(path.join(process.env.NONVEG_DIR, 'm_noaa20_nonveg_2025.bin'));
  for (let o = 0; o < b.length; o += 9) { const c = b.readUInt32LE(o), n = b.readUInt32LE(o + 5); nonvegC.set(c, (nonvegC.get(c) || 0) + n); const bl = Math.floor(Math.floor(c / 1440) / 4) * 360 + Math.floor((c % 1440) / 4); nonvegB.set(bl, (nonvegB.get(bl) || 0) + n); }
  for (const [c, a] of cells) { let v = 0; for (let j = 0; j < 12; j++) v += a[3 * NM + (2025 - Y0) * 12 + j]; if (v) { vegC.set(c, v); const bl = Math.floor(Math.floor(c / 1440) / 4) * 360 + Math.floor((c % 1440) / 4); vegB.set(bl, (vegB.get(bl) || 0) + v); } }
}
const staticShare = c => { const nv = nonvegC.get(c) || 0; if (!nv) return 0; return nv / (nv + (vegC.get(c) || 0)); };
const staticShareB = b => { const nv = nonvegB.get(b) || 0; if (!nv) return 0; return nv / (nv + (vegB.get(b) || 0)); };
let nrtRaw = 0, nrtKept = 0;
for (const dir of aggDirs) for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^m_noaa20_notype_(\d{4})\.bin$/); if (!m) continue; const y = +m[1];
  const b = fs.readFileSync(path.join(dir, f));
  for (let o = 0; o < b.length; o += 9) { const c = b.readUInt32LE(o), mo = b.readUInt8(o + 4), n = b.readUInt32LE(o + 5); const sh = staticShare(c); if (sh > 0) NRT_NOTE.cellsWithStaticShare++; const k = Math.round(n * (1 - sh)); nrtRaw += n; nrtKept += k; cellArr(c)[3 * NM + (y - Y0) * 12 + mo] += k; }
}
NRT_NOTE.raw = nrtRaw; NRT_NOTE.kept = nrtKept; console.log('NRT static-source correction', NRT_NOTE);
console.log('active cells', cells.size);

// ---------- global availability per series/month ----------
const glob = SER.map(() => new Float64Array(NM));
for (const a of cells.values()) for (let s = 0; s < 4; s++) for (let m = 0; m < NM; m++) glob[s][m] += a[s * NM + m];
const avail = glob.map(g => { const mx = Math.max(...g); return Array.from(g, v => v > 0.25 * median(Array.from(g).filter(x => x > 0))); });
function median(xs) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
const firstAvail = s => avail[s].indexOf(true), lastAvail = s => avail[s].lastIndexOf(true);
const SNPP_START = Math.max(firstAvail(S.snpp), mi(2012, 2));     // Jan 2012 is partial (data from 20 Jan)
const N20_START = Math.max(firstAvail(S.noaa20), mi(2018, 4));    // NOAA-20 standard product from 1 Apr 2018
const LAST = lastAvail(S.noaa20);
console.log('eras', { SNPP_START, N20_START, LAST, terra: [firstAvail(0), lastAvail(0)], aqua: [firstAvail(1), lastAvail(1)], snpp: [firstAvail(2), lastAvail(2)] });

// ---------- calibration helpers ----------
const row = c => Math.floor(c / 1440), col = c => c % 1440;
const blockOf = c => Math.floor(row(c) / 4) * 360 + Math.floor(col(c) / 4);       // 1 deg
const tileOf = c => Math.floor(row(c) / 20) * 72 + Math.floor(col(c) / 20);       // 5 deg
function ratioModel(numS, denS, months, lambda) {
  // returns { k: Map cell->k, kGlobal }
  const sums = new Map(), bSum = new Map(), tSum = new Map(); let gN = 0, gD = 0;
  for (const [c, a] of cells) {
    let n = 0, d = 0;
    for (const m of months) { n += a[numS * NM + m]; d += a[denS * NM + m]; }
    if (!n && !d) continue;
    sums.set(c, [n, d]); gN += n; gD += d;
    const b = blockOf(c), t = tileOf(c);
    const bb = bSum.get(b) || [0, 0]; bb[0] += n; bb[1] += d; bSum.set(b, bb);
    const tt = tSum.get(t) || [0, 0]; tt[0] += n; tt[1] += d; tSum.set(t, tt);
  }
  const kG = gN / gD;
  const kT = new Map(); for (const [t, [n, d]] of tSum) kT.set(t, (n + lambda * kG) / (d + lambda));
  const kB = new Map(); for (const [b, [n, d]] of bSum) { const t = Math.floor(Math.floor(b / 360) / 5) * 72 + Math.floor((b % 360) / 5); kB.set(b, (n + lambda * (kT.get(t) ?? kG)) / (d + lambda)); }
  const k = new Map(); for (const [c, [n, d]] of sums) k.set(c, (n + lambda * (kB.get(blockOf(c)) ?? kG)) / (d + lambda));
  return { k, kG, kB, kT };
}
// Seasonal variant: one ratio per cell and calendar month, shrunk toward the 1 deg block's ratio for that
// calendar month, which is shrunk toward the block's annual ratio (from ratioModel).
function ratioModelSeasonal(numS, denS, months, lambda, base) {
  const cs = new Map(), bs = new Map();
  for (const [c, a] of cells) {
    let any = false; const v = new Float64Array(24);
    for (const m of months) { const j = m % 12; const n = a[numS * NM + m], d = a[denS * NM + m]; if (n || d) { any = true; v[j] += n; v[12 + j] += d; } }
    if (!any) continue; cs.set(c, v);
    const b = blockOf(c); let bv = bs.get(b); if (!bv) { bv = new Float64Array(24); bs.set(b, bv); } for (let i = 0; i < 24; i++) bv[i] += v[i];
  }
  const kb = new Map(); for (const [b, v] of bs) { const kb0 = base.kB.get(b) ?? base.kG; const out = new Float64Array(12); for (let j = 0; j < 12; j++) out[j] = (v[j] + lambda * kb0) / (v[12 + j] + lambda); kb.set(b, out); }
  const k = new Map(); for (const [c, v] of cs) { const p = kb.get(blockOf(c)); const out = new Float64Array(12); for (let j = 0; j < 12; j++) out[j] = (v[j] + lambda * p[j]) / (v[12 + j] + lambda); k.set(c, out); }
  return { k, kb, kG: base.kG };
}
const SEASONAL = process.env.SEASONAL === '1';
const kOf = (model, c, m) => { const v = model.k.get(c); if (v === undefined) return model.kG; return typeof v === 'number' ? v : v[m % 12]; };
const range = (a, b) => { const r = []; for (let m = a; m <= b; m++) r.push(m); return r; };
const onlyAvail = (ms, ss) => ms.filter(m => ss.every(s => avail[s][m]));

function predictModis(a, m, kTerra, kAqua, c) {
  let sum = 0, n = 0;
  if (avail[S.terra][m]) { sum += kOf(kTerra, c, m) * a[S.terra * NM + m]; n++; }
  if (avail[S.aqua][m]) { sum += kOf(kAqua, c, m) * a[S.aqua * NM + m]; n++; }
  return n ? sum / n : NaN;
}



// ---------- FireRelay pipeline step 4 (validate_methods.mjs) ----------
// 1) Method contest on the same hold-out tests: FireRelay (per-cell seasonal ratio with shrinkage), one global ratio,
//    quantile mapping (per 5 deg tile, cell-months), log-log regression (per 5 deg tile, Duan smearing), raw MODIS.
// 2) Recalibrates the 80% range: one scale factor on the log quantiles, fitted on Test A, checked on Test B.
// 3) Exports per-1-deg-block hold-out series for the app's "measured error for this area" readout.
const presets = JSON.parse(fs.readFileSync(path.join(webDir, 'data', 'geo', 'presets.json'), 'utf8'));
const META = JSON.parse(fs.readFileSync(path.join(webDir, 'data', 'meta.json'), 'utf8'));
const UNC = META.uncertainty;
function inRing(x, y, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
function inGeom(x, y, g) { const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const p of polys) { if (inRing(x, y, p[0])) { let hole = false; for (let k = 1; k < p.length; k++) if (inRing(x, y, p[k])) hole = true; if (!hole) return true; } } return false; }
const regIdx = new Map();
presets.forEach((p, i) => { for (const c of cells.keys()) { const lat = row(c) * 0.25 - 90 + 0.125, lon = col(c) * 0.25 - 180 + 0.125; if (inGeom(lon, lat, p.geometry)) { const a = regIdx.get(c) || []; a.push(i); regIdx.set(c, a); } } });
const ape = (p, o) => Math.abs(p - o) / (o + 1);
const modisAvg = (a, m) => { const nA = (avail[S.terra][m] ? 1 : 0) + (avail[S.aqua][m] ? 1 : 0); return nA ? ((avail[S.terra][m] ? a[S.terra * NM + m] : 0) + (avail[S.aqua][m] ? a[S.aqua * NM + m] : 0)) / nA : 0; };
function fitBaselines(train) {
  const tm = onlyAvail(train, [S.snpp, S.terra]);
  const byTile = new Map();
  for (const [c, a] of cells) { const t = tileOf(c); let r = byTile.get(t); if (!r) { r = { M: [], V: [], z: [0, 0] }; byTile.set(t, r); }
    for (const m of tm) { const M = modisAvg(a, m), V = a[S.snpp * NM + m]; if (M === 0 && V === 0) continue; if (M === 0) { r.z[0] += V; r.z[1]++; continue; } if (r.M.length < 40000 || Math.random() < 40000 / (r.M.length + 1)) { if (r.M.length < 40000) { r.M.push(M); r.V.push(V); } else { const k = Math.floor(Math.random() * 40000); r.M[k] = M; r.V[k] = V; } } } }
  const qm = new Map(), lr = new Map();
  let gM = [], gV = [];
  for (const [t, r] of byTile) {
    if (r.M.length >= 30) { const Ms = Float64Array.from(r.M).sort(), Vs = Float64Array.from(r.V).sort(); qm.set(t, { Ms, Vs, z: r.z[1] ? r.z[0] / r.z[1] : 0 });
      let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = r.M.length; for (let i = 0; i < n; i++) { const x = Math.log(r.M[i] + 1), y = Math.log(r.V[i] + 1); sx += x; sy += y; sxx += x * x; sxy += x * y; } const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - b * sx) / n; let sm = 0; for (let i = 0; i < n; i++) sm += Math.exp(Math.log(r.V[i] + 1) - (a0 + b * Math.log(r.M[i] + 1))); lr.set(t, { a: a0, b, smear: sm / n, z: r.z[1] ? r.z[0] / r.z[1] : 0 }); }
    for (let i = 0; i < r.M.length; i += 4) { gM.push(r.M[i]); gV.push(r.V[i]); } }
  const G = { Ms: Float64Array.from(gM).sort(), Vs: Float64Array.from(gV).sort(), z: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = gM.length; for (let i = 0; i < n; i++) { const x = Math.log(gM[i] + 1), y = Math.log(gV[i] + 1); sx += x; sy += y; sxx += x * x; sxy += x * y; } const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - b * sx) / n; let sm = 0; for (let i = 0; i < n; i++) sm += Math.exp(Math.log(gV[i] + 1) - (a0 + b * Math.log(gM[i] + 1)));
  const GL = { a: a0, b, smear: sm / n, z: 0 };
  return { qm, lr, G, GL };
}
function qmap(q, x) { if (x === 0) return q.z; const Ms = q.Ms, Vs = q.Vs; let lo = 0, hi = Ms.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (Ms[mid] < x) lo = mid + 1; else hi = mid; } let lo2 = lo, hi2 = Ms.length; while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (Ms[mid] <= x) lo2 = mid + 1; else hi2 = mid; } const p = ((lo + lo2) / 2) / Ms.length; return Vs[Math.min(Vs.length - 1, Math.floor(p * Vs.length))]; }
function lreg(l, x) { if (x === 0) return l.z; return Math.max(0, Math.exp(l.a + l.b * Math.log(x + 1)) * l.smear - 1); }
const METHODS = ['fire', 'glob', 'qm', 'lr', 'raw'];
function contest(train, test, lambda, label, wantBlocks) {
  let mT = ratioModel(S.snpp, S.terra, onlyAvail(train, [S.snpp, S.terra]), lambda), mA = ratioModel(S.snpp, S.aqua, onlyAvail(train, [S.snpp, S.aqua]), lambda);
  mT = ratioModelSeasonal(S.snpp, S.terra, onlyAvail(train, [S.snpp, S.terra]), lambda, mT); mA = ratioModelSeasonal(S.snpp, S.aqua, onlyAvail(train, [S.snpp, S.aqua]), lambda, mA);
  const B = fitBaselines(train);
  const units = { block: c => [blockOf(c)], tile: c => [tileOf(c)], region: c => regIdx.get(c) || [], globe: () => [0] };
  const res = {}; let blocks = null;
  for (const [uname, uf] of Object.entries(units)) {
    const agg = new Map();
    for (const [c, a] of cells) { const us = uf(c); if (!us.length) continue; const t = tileOf(c); const q = B.qm.get(t) || B.G, l = B.lr.get(t) || B.GL;
      for (const u of us) { let r = agg.get(u); if (!r) { r = { obs: new Float64Array(NM) }; for (const k of METHODS) r[k] = new Float64Array(NM); agg.set(u, r); }
        for (const m of test) { const M = modisAvg(a, m); r.obs[m] += a[S.snpp * NM + m]; r.fire[m] += predictModis(a, m, mT, mA, c); r.raw[m] += M;
          const nA = (avail[S.terra][m] ? 1 : 0) + (avail[S.aqua][m] ? 1 : 0); r.glob[m] += ((avail[S.terra][m] ? mT.kG * a[S.terra * NM + m] : 0) + (avail[S.aqua][m] ? mA.kG * a[S.aqua * NM + m] : 0)) / Math.max(1, nA);
          r.qm[m] += qmap(q, M); r.lr[m] += lreg(l, M); } } }
    const years = [...new Set(test.map(m => Math.floor(m / 12)))];
    const mon = Object.fromEntries(METHODS.map(k => [k, []])), ann = Object.fromEntries(METHODS.map(k => [k, []])); const bias = Object.fromEntries(METHODS.map(k => [k, [0, 0]]));
    for (const r of agg.values()) { for (const m of test) { const o = r.obs[m]; if (o < 10) continue; for (const k of METHODS) { mon[k].push(ape(r[k][m], o)); bias[k][0] += r[k][m]; bias[k][1] += o; } }
      for (const yy of years) { const ms = test.filter(m => Math.floor(m / 12) === yy); const o = ms.reduce((s, m) => s + r.obs[m], 0); if (o < 100) continue; for (const k of METHODS) ann[k].push(ape(ms.reduce((s, m) => s + r[k][m], 0), o)); } }
    res[uname] = { nMonthly: mon.fire.length, nAnnual: ann.fire.length, monthly: Object.fromEntries(METHODS.map(k => [k, median(mon[k])])), annual: Object.fromEntries(METHODS.map(k => [k, median(ann[k])])), bias: Object.fromEntries(METHODS.map(k => [k, bias[k][0] / bias[k][1] - 1])) };
    if (uname === 'block' && wantBlocks) blocks = agg;
  }
  console.log(label, JSON.stringify(res));
  return { res, blocks };
}
const OUTV = { lambda: LAMBDA, note: 'Median absolute % error of hold-out totals vs S-NPP VIIRS (|p-o|/(o+1)). monthly: unit-months with >=10 observed; annual: unit-years with >=100 observed. Methods: fire = FireRelay; glob = one global ratio per MODIS satellite; qm = quantile mapping per 5 deg tile on cell-months; lr = log-log regression per 5 deg tile with smearing; raw = raw MODIS.' };
const testA = range(mi(2017, 1), mi(2019, 12)), testB = range(mi(2020, 1), mi(2025, 12));
const A = contest(range(mi(2012, 2), mi(2016, 12)), testA, LAMBDA, 'A', true);
const Bc = contest(range(mi(2012, 2), mi(2019, 12)), testB, LAMBDA, 'B', true);
OUTV.testA = A.res; OUTV.testB = Bc.res;
// ---- interval recalibration (block-level monthly totals) ----
function coverage(agg, test, s) { let n = 0, h = 0; for (const r of agg.values()) for (const m of test) { const o = r.obs[m]; if (o < 10) continue; const v = r.fire[m]; const b = UNC.find(x => v >= x.lo && v < x.hi) || UNC[UNC.length - 1]; n++; if (o >= v * Math.exp(s * b.q10) && o <= v * Math.exp(s * b.q90)) h++; } return h / n; }
let s = 1; for (let k = 0; k < 40 && coverage(A.blocks, testA, s) < 0.8; k++) s += 0.05;
OUTV.rangeScale = +s.toFixed(2);
OUTV.coverage = { before: { A: coverage(A.blocks, testA, 1), B: coverage(Bc.blocks, testB, 1) }, after: { A: coverage(A.blocks, testA, s), B: coverage(Bc.blocks, testB, s) } };
console.log('range scale', s, JSON.stringify(OUTV.coverage));
fs.writeFileSync(OUT, JSON.stringify(OUTV, null, 1));
// ---- per-block export: Test A monthly obs/pred/raw (36) + Test B yearly obs/pred (6) ----
const recs = [];
for (const [b, r] of A.blocks) { let so = 0; for (const m of testA) so += r.obs[m]; const rb = Bc.blocks.get(b); if (so < 1 && !rb) continue; const v = new Uint32Array(1 + 36 * 3 + 12); v[0] = b; testA.forEach((m, i) => { v[1 + i] = Math.round(r.obs[m]); v[37 + i] = Math.round(r.fire[m]); v[73 + i] = Math.round(r.raw[m]); }); if (rb) for (let y = 0; y < 6; y++) { let o = 0, p = 0; for (let j = 0; j < 12; j++) { const m = testB[y * 12 + j]; o += rb.obs[m]; p += rb.fire[m]; } v[109 + y] = Math.round(o); v[115 + y] = Math.round(p); } recs.push(v); }
const buf = Buffer.alloc(recs.length * 121 * 4); recs.forEach((v, i) => Buffer.from(v.buffer).copy(buf, i * 121 * 4));
fs.writeFileSync(path.join(webDir, 'data', 'holdout_blocks.bin'), zlib.gzipSync(buf, { level: 9 }));
console.log('blocks', recs.length, 'bytes', buf.length);
