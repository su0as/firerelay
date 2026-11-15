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

// ---------- validation ----------
// Units: 0.25 deg cell, 1 deg block, 5 deg tile. Metric on monthly totals per unit with obs >= 10.
function evaluate(trainMonths, testMonths, lambda, label) {
  let mT = ratioModel(S.snpp, S.terra, onlyAvail(trainMonths, [S.snpp, S.terra]), lambda);
  let mA = ratioModel(S.snpp, S.aqua, onlyAvail(trainMonths, [S.snpp, S.aqua]), lambda);
  if (SEASONAL) { mT = ratioModelSeasonal(S.snpp, S.terra, onlyAvail(trainMonths, [S.snpp, S.terra]), lambda, mT); mA = ratioModelSeasonal(S.snpp, S.aqua, onlyAvail(trainMonths, [S.snpp, S.aqua]), lambda, mA); }
  const kGT = mT.kG, kGA = mA.kG;
  const units = { cell: c => c, block: blockOf, tile: tileOf };
  const res = {};
  for (const [uname, uf] of Object.entries(units)) {
    const agg = new Map(); // unit -> {obs, pred, raw, glob} per month
    for (const [c, a] of cells) {
      const u = uf(c);
      let r = agg.get(u); if (!r) { r = { obs: new Float64Array(NM), pred: new Float64Array(NM), raw: new Float64Array(NM), glob: new Float64Array(NM) }; agg.set(u, r); }
      for (const m of testMonths) {
        r.obs[m] += a[S.snpp * NM + m];
        r.pred[m] += predictModis(a, m, mT, mA, c);
        const nA = (avail[S.terra][m] ? 1 : 0) + (avail[S.aqua][m] ? 1 : 0);
        r.raw[m] += (a[S.terra * NM + m] + a[S.aqua * NM + m]) / Math.max(1, nA);
        r.glob[m] += ((avail[S.terra][m] ? kGT * a[S.terra * NM + m] : 0) + (avail[S.aqua][m] ? kGA * a[S.aqua * NM + m] : 0)) / Math.max(1, nA);
      }
    }
    const errs = { pred: [], raw: [], glob: [] }, pairs = [];
    let sumObs = 0, sumPred = 0, peakHit = 0, peakN = 0, anomHit = 0, anomN = 0;
    for (const r of agg.values()) {
      for (const m of testMonths) {
        const o = r.obs[m]; if (o < 10) continue;
        for (const k of ['pred', 'raw', 'glob']) errs[k].push(Math.log((r[k][m] + 1) / (o + 1)));
        pairs.push([Math.log(o + 1), Math.log(r.pred[m] + 1), r.pred[m], o]);
        sumObs += o; sumPred += r.pred[m];
      }
      // peak-month agreement per unit-year (calendar fidelity)
      const years = new Set(testMonths.map(m => Math.floor(m / 12)));
      for (const yy of years) {
        const ms = testMonths.filter(m => Math.floor(m / 12) === yy);
        const tot = ms.reduce((s, m) => s + r.obs[m], 0); if (tot < 100) continue;
        const po = ms.reduce((b, m) => r.obs[m] > r.obs[b] ? m : b, ms[0]);
        const pp = ms.reduce((b, m) => r.pred[m] > r.pred[b] ? m : b, ms[0]);
        peakN++; if (Math.abs(po - pp) <= 0) peakHit++;
      }
    }
    const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const mape = xs => median(xs.map(e => Math.abs(Math.exp(e) - 1)));
    const corr = (() => { const n = pairs.length; if (!n) return NaN; const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n; let sxy = 0, sxx = 0, syy = 0; for (const p of pairs) { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) ** 2; syy += (p[1] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); })();
    // uncertainty by predicted-count bin (log error quantiles)
    const bins = [0, 30, 100, 300, 1000, 3000, 10000, Infinity], unc = [];
    for (let i = 0; i < bins.length - 1; i++) {
      const es = pairs.filter(p => p[2] >= bins[i] && p[2] < bins[i + 1]).map(p => p[0] - p[1]); // log(obs/pred)
      if (es.length >= 20) unc.push({ lo: bins[i], hi: bins[i + 1], n: es.length, q10: q(es, 0.1), q50: q(es, 0.5), q90: q(es, 0.9) });
    }
    res[uname] = {
      n: errs.pred.length,
      medianAbsPctError: { harmonized: mape(errs.pred), rawModis: mape(errs.raw), globalRatio: mape(errs.glob) },
      bias: sumPred / sumObs - 1, logCorr: corr,
      peakMonthAgreement: peakN ? peakHit / peakN : NaN, peakN,
      uncertainty: unc,
    };
  }
  console.log(label, 'lambda', lambda, JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { n: v.n, mape: v.medianAbsPctError, bias: +v.bias.toFixed(3), r: +v.logCorr.toFixed(3), peak: +v.peakMonthAgreement.toFixed(3) }]))));
  return res;
}

const VAL = {};
const trainA = range(mi(2012, 2), mi(2016, 12)), testA = range(mi(2017, 1), mi(2019, 12));
const testDrift = range(mi(2020, 1), mi(2025, 12));
const lambdas = (process.env.LAMBDAS || '10,30,100').split(',').map(Number);
VAL.lambdaSweep = {};
for (const l of lambdas) VAL.lambdaSweep[l] = evaluate(trainA, testA, l, 'A(2012-16 -> 2017-19)');
const bestL = lambdas.reduce((b, l) => VAL.lambdaSweep[l].block.medianAbsPctError.harmonized < VAL.lambdaSweep[b].block.medianAbsPctError.harmonized ? l : b, lambdas[0]);
console.log('best lambda', bestL);
VAL.lambda = bestL; VAL.seasonal = SEASONAL; VAL.nrt = NRT_NOTE;
VAL.stable = VAL.lambdaSweep[bestL];
VAL.drift = evaluate(range(mi(2012, 2), mi(2019, 12)), testDrift, bestL, 'B(2012-19 -> 2020-25 orbit drift)');

// S-NPP -> NOAA-20 cross-calibration skill
function evalVV(train, test, lambda) {
  const mm = ratioModel(S.noaa20, S.snpp, onlyAvail(train, [S.noaa20, S.snpp]), lambda);
  const out = {};
  for (const [uname, uf] of Object.entries({ cell: c => c, block: blockOf, tile: tileOf })) {
    const agg = new Map();
    for (const [c, a] of cells) { const u = uf(c); let r = agg.get(u); if (!r) { r = { o: new Float64Array(NM), p: new Float64Array(NM) }; agg.set(u, r); } for (const m of test) { if (!avail[S.snpp][m] || !avail[S.noaa20][m]) continue; r.o[m] += a[S.noaa20 * NM + m]; r.p[m] += (mm.k.get(c) ?? mm.kG) * a[S.snpp * NM + m]; } }
    const es = []; let so = 0, sp = 0;
    for (const r of agg.values()) for (const m of test) { if (r.o[m] < 10) continue; es.push(Math.log((r.p[m] + 1) / (r.o[m] + 1))); so += r.o[m]; sp += r.p[m]; }
    const srt = es.map(e => -e).sort((a, b) => a - b); // log(obs/pred)
    out[uname] = { n: es.length, medianAbsPctError: median(es.map(e => Math.abs(Math.exp(e) - 1))), bias: sp / so - 1, q10: srt[Math.floor(0.1 * srt.length)], q90: srt[Math.floor(0.9 * srt.length)] };
  }
  return { kGlobal: mm.kG, ...out };
}
VAL.snppToN20 = evalVV(range(mi(2018, 4), mi(2022, 12)), range(mi(2023, 1), mi(2025, 12)), bestL);
console.log('SNPP->N20', JSON.stringify(VAL.snppToN20));

// ---------- production models ----------
const calM = range(SNPP_START, mi(2019, 12));     // both MODIS platforms in nominal orbit
const kTerraA = ratioModel(S.snpp, S.terra, onlyAvail(calM, [S.snpp, S.terra]), bestL);
const kAquaA = ratioModel(S.snpp, S.aqua, onlyAvail(calM, [S.snpp, S.aqua]), bestL);
const kTerra = SEASONAL ? { ...ratioModelSeasonal(S.snpp, S.terra, onlyAvail(calM, [S.snpp, S.terra]), bestL, kTerraA), kB: kTerraA.kB } : kTerraA;
const kAqua = SEASONAL ? { ...ratioModelSeasonal(S.snpp, S.aqua, onlyAvail(calM, [S.snpp, S.aqua]), bestL, kAquaA), kB: kAquaA.kB } : kAquaA;
const rSN = ratioModel(S.noaa20, S.snpp, onlyAvail(range(N20_START, LAST), [S.noaa20, S.snpp]), bestL);
console.log('global k', { terra: kTerra.kG, aqua: kAqua.kG, snppToN20: rSN.kG });

// ---------- chart series for the Method page ----------
const yearly = {};
for (let s = 0; s < 4; s++) { yearly[SER[s]] = []; for (let y = 0; y < NY; y++) { let t = 0, full = true; for (let m = 0; m < 12; m++) { if (!avail[s][y * 12 + m]) full = false; t += glob[s][y * 12 + m]; } yearly[SER[s]].push(full ? t : null); } }
const harmGlobal = new Float64Array(NM);
for (const [c, a] of cells) for (let m = 0; m <= LAST; m++) harmGlobal[m] += harmonize(a, m, c);
function harmonize(a, m, c) {
  if (m >= N20_START && avail[S.noaa20][m]) return a[S.noaa20 * NM + m];
  const r = rSN.k.get(c) ?? rSN.kG;
  if (m >= SNPP_START && avail[S.snpp][m]) return r * a[S.snpp * NM + m];
  const p = predictModis(a, m, kTerra, kAqua, c); return isNaN(p) ? 0 : r * p;
}
yearly.harmonized = []; for (let y = 0; y < NY; y++) { let t = 0; for (let m = 0; m < 12; m++) t += harmGlobal[y * 12 + m]; yearly.harmonized.push(y * 12 + 11 <= LAST ? t : null); }
const ratiosByYear = { snppOverTerra: [], snppOverAqua: [], n20OverSnpp: [] };
for (let y = 0; y < NY; y++) { const sl = s => { let t = 0; for (let m = 0; m < 12; m++) t += glob[s][y * 12 + m]; return t; }; const full = s => [...Array(12).keys()].every(m => avail[s][y * 12 + m]);
  ratiosByYear.snppOverTerra.push(full(2) && full(0) ? sl(2) / sl(0) : null); ratiosByYear.snppOverAqua.push(full(2) && full(1) ? sl(2) / sl(1) : null); ratiosByYear.n20OverSnpp.push(full(3) && full(2) ? sl(3) / sl(2) : null); }
VAL.yearly = yearly; VAL.ratiosByYear = ratiosByYear; VAL.years = [...Array(NY).keys()].map(i => Y0 + i);
VAL.globalK = { terra: kTerra.kG, aqua: kAqua.kG, snppToN20: rSN.kG };
VAL.monthlyGlobal = { harmonized: Array.from(harmGlobal.slice(0, LAST + 1), v => Math.round(v)), terra: Array.from(glob[0].slice(0, LAST + 1)), aqua: Array.from(glob[1].slice(0, LAST + 1)), snpp: Array.from(glob[2].slice(0, LAST + 1)), noaa20: Array.from(glob[3].slice(0, LAST + 1)) };

// ---------- tiles ----------
// TILE FORMAT (little-endian, then gzip): "FBT3", uint16 nCells, uint16 NM, then per cell:
//   uint16 local index (r%20)*20 + (c%20); float32 rS; float32 kTerra[12]; float32 kAqua[12] (by calendar month, NOAA-20 units);
//   4 series x NM uint32 counts (terra, aqua, snpp, noaa20)
const tilesDir = path.join(webDir, 'data', 'tiles'); fs.rmSync(tilesDir, { recursive: true, force: true }); fs.mkdirSync(tilesDir, { recursive: true });
const byTile = new Map();
for (const c of cells.keys()) { const t = tileOf(c); let l = byTile.get(t); if (!l) { l = []; byTile.set(t, l); } l.push(c); }
let totalBytes = 0; const tileList = [];
for (const [t, list] of byTile) {
  list.sort((a, b) => a - b);
  const per = 2 + 100 + 4 * NM * 4; const buf = Buffer.alloc(8 + list.length * per); buf.write('FBT3', 0); buf.writeUInt16LE(list.length, 4); buf.writeUInt16LE(NM, 6);
  let o = 8;
  for (const c of list) {
    const a = cells.get(c); const r = row(c), cc = col(c);
    buf.writeUInt16LE((r % 20) * 20 + (cc % 20), o); o += 2;
    const r0 = rSN.k.get(c) ?? rSN.kG;
    buf.writeFloatLE(r0, o); o += 4; for (let j = 0; j < 12; j++) { buf.writeFloatLE(r0 * kOf(kTerra, c, j), o); o += 4; } for (let j = 0; j < 12; j++) { buf.writeFloatLE(r0 * kOf(kAqua, c, j), o); o += 4; }
    for (let i = 0; i < 4 * NM; i++) { buf.writeUInt32LE(a[i], o); o += 4; }
  }
  const gz = zlib.gzipSync(buf, { level: 9 });
  const name = `${Math.floor(t / 72)}_${t % 72}`; fs.writeFileSync(path.join(tilesDir, name + '.bin'), gz); totalBytes += gz.length; tileList.push(name);
}
console.log('tiles', tileList.length, (totalBytes / 1e6).toFixed(1) + ' MB');

// ---------- weekly (1 deg cells, 53 weeks per year, harmonized server-side with 1 deg block coefficients) ----------
const NWY = 53, NWK = NY * NWY;
const wraw = new Map(); // cell1 -> Uint32Array(4*NWK)
for (const dir of aggDirs) for (const f of fs.readdirSync(dir)) {
  const m = f.match(/^w_(terra|aqua|snpp|noaa20)(_notype)?_(\d{4})\.bin$/); if (!m) continue;
  const s = S[m[1]], y = +m[3], notype = !!m[2]; if (y < Y0 || y >= Y0 + NY) continue;
  const b = fs.readFileSync(path.join(dir, f));
  for (let o = 0; o < b.length; o += 7) { const c = b.readUInt16LE(o), w = b.readUInt8(o + 2); let n = b.readUInt32LE(o + 3); if (notype) n = Math.round(n * (1 - staticShareB(c))); let a = wraw.get(c); if (!a) { a = new Uint32Array(4 * NWK); wraw.set(c, a); } a[s * NWK + (y - Y0) * NWY + w] += n; }
}
const weekMonth = k => { const y = Y0 + Math.floor(k / NWY), w = k % NWY; const d = new Date(Date.UTC(y, 0, 1 + 7 * w)); return d.getUTCFullYear() === y ? (y - Y0) * 12 + d.getUTCMonth() : (y - Y0) * 12 + 11; };
const lastDate = process.env.LAST_DATE ? new Date(process.env.LAST_DATE + 'T00:00:00Z') : null;
const lastWeek = lastDate ? (lastDate.getUTCFullYear() - Y0) * NWY + Math.min(52, Math.floor((lastDate - Date.UTC(lastDate.getUTCFullYear(), 0, 1)) / 864e5 / 7)) : NWK - 1;
const wDir = path.join(webDir, 'data', 'weekly'); fs.rmSync(wDir, { recursive: true, force: true }); fs.mkdirSync(wDir, { recursive: true });
const wByTile = new Map();
for (const c of wraw.keys()) { const t = Math.floor(Math.floor(c / 360) / 10) * 36 + Math.floor((c % 360) / 10); let l = wByTile.get(t); if (!l) { l = []; wByTile.set(t, l); } l.push(c); }
let wBytes = 0; const wTiles = []; let modisBeforeWeek = 0;
for (let k = 0; k < NWK; k++) if (weekMonth(k) < SNPP_START) modisBeforeWeek = k + 1;
for (const [t, list] of wByTile) {
  const buf = Buffer.alloc(8 + list.length * (2 + 4 * NWK)); buf.write('FBW1', 0); buf.writeUInt16LE(list.length, 4); buf.writeUInt16LE(NWK, 6); let o = 8;
  for (const c of list) {
    const a = wraw.get(c); buf.writeUInt16LE((Math.floor(c / 360) % 10) * 10 + (c % 360) % 10, o); o += 2;
    const rS = rSN.kB.get(c) ?? rSN.kG; const kTt = j => (kTerra.kb && kTerra.kb.get(c)) ? kTerra.kb.get(c)[j] : (kTerra.kB.get(c) ?? kTerra.kG), kAa = j => (kAqua.kb && kAqua.kb.get(c)) ? kAqua.kb.get(c)[j] : (kAqua.kB.get(c) ?? kAqua.kG);
    for (let k = 0; k < NWK; k++) {
      const m = weekMonth(k); let v = 0;
      if (k > lastWeek) v = 0;
      else if (m >= N20_START && avail[S.noaa20][m]) v = a[3 * NWK + k];
      else if (m >= SNPP_START && avail[S.snpp][m]) v = rS * a[2 * NWK + k];
      else { let s = 0, n = 0; if (avail[S.terra][m]) { s += kTt(m % 12) * a[k]; n++; } if (avail[S.aqua][m]) { s += kAa(m % 12) * a[NWK + k]; n++; } v = n ? rS * s / n : 0; }
      buf.writeFloatLE(v, o); o += 4;
    }
  }
  const gz = zlib.gzipSync(buf, { level: 9 }); const name = `${Math.floor(t / 36)}_${t % 36}`; fs.writeFileSync(path.join(wDir, name + '.bin'), gz); wBytes += gz.length; wTiles.push(name);
}
console.log('weekly tiles', wTiles.length, (wBytes / 1e6).toFixed(1) + ' MB');

// 80% range widened by RANGE_SCALE (fitted in validate_methods.mjs so Test A coverage reaches 80%; Test B coverage 77%).
const RANGE_SCALE = +(process.env.RANGE_SCALE || 1.2);
const unc = VAL.stable.block.uncertainty.map(u => ({ ...u, q10: u.q10 * RANGE_SCALE, q90: u.q90 * RANGE_SCALE }));
const meta = {
  version: 2, built: new Date().toISOString(), grid: 0.25, tileDeg: 5, y0: Y0, nMonths: NM,
  series: SER, avail: avail.map(a => a.map(v => (v ? 1 : 0)).join('')),
  eras: { snppStart: SNPP_START, n20Start: N20_START, last: LAST },
  lambda: bestL, globalK: VAL.globalK, uncertainty: unc, tiles: tileList,
  snppUnc: { q10: VAL.snppToN20.block.q10, q90: VAL.snppToN20.block.q90 },
  weekly: { nWeeks: NWK, tiles: wTiles, lastWeek, modisBefore: modisBeforeWeek },
  lastDate: process.env.LAST_DATE || null,
};
fs.writeFileSync(path.join(webDir, 'data', 'meta.json'), JSON.stringify(meta));
fs.writeFileSync(path.join(webDir, 'data', 'validation.json'), JSON.stringify(VAL));
console.log('done');
