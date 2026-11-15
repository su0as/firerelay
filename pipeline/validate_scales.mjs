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


// ---------- extra validation: the same hold-out tests, scored at the scales other teams report ----------
// FireRelay pipeline step 3 (validate_scales.mjs). Same calibration as build.mjs (seasonal, LAMBDA), same hold-out years.
// Scores: monthly and annual totals for 1 deg blocks, 5 deg tiles, the named app regions, and the whole globe.
// Also checks the app's 80% range: share of hold-out totals that fall inside it.
const presets = JSON.parse(fs.readFileSync(path.join(webDir, 'data', 'geo', 'presets.json'), 'utf8'));
const META = JSON.parse(fs.readFileSync(path.join(webDir, 'data', 'meta.json'), 'utf8'));
const UNC = META.uncertainty;
function inRing(x, y, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
function inGeom(x, y, g) { const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const p of polys) { if (inRing(x, y, p[0])) { let hole = false; for (let k = 1; k < p.length; k++) if (inRing(x, y, p[k])) hole = true; if (!hole) return true; } } return false; }
const regionCells = presets.map(p => { const g = p.geometry; let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const q of polys) for (const [x, y] of q[0]) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); } const set = new Set(); for (const c of cells.keys()) { const lat = row(c) * 0.25 - 90 + 0.125, lon = col(c) * 0.25 - 180 + 0.125; if (lon < mnx || lon > mxx || lat < mny || lat > mxy) continue; if (inGeom(lon, lat, g)) set.add(c); } return { id: p.id, name: p.name, set }; });
console.log('regions', regionCells.map(r => r.id + ':' + r.set.size).join(' '));
const median2 = xs => median(xs);
const ape = (p, o) => Math.abs(p - o) / (o + 1); // same metric as build.mjs: |exp(log((p+1)/(o+1))) - 1|
function evalScales(trainMonths, testMonths, lambda, label) {
  let mT = ratioModel(S.snpp, S.terra, onlyAvail(trainMonths, [S.snpp, S.terra]), lambda);
  let mA = ratioModel(S.snpp, S.aqua, onlyAvail(trainMonths, [S.snpp, S.aqua]), lambda);
  mT = ratioModelSeasonal(S.snpp, S.terra, onlyAvail(trainMonths, [S.snpp, S.terra]), lambda, mT); mA = ratioModelSeasonal(S.snpp, S.aqua, onlyAvail(trainMonths, [S.snpp, S.aqua]), lambda, mA);
  const kGT = mT.kG, kGA = mA.kG;
  // per-cell series for test months
  const units = { block: c => [blockOf(c)], tile: c => [tileOf(c)], globe: c => [0] };
  const regIdx = new Map(); regionCells.forEach((r, i) => { for (const c of r.set) { const a = regIdx.get(c) || []; a.push(i); regIdx.set(c, a); } });
  units.region = c => regIdx.get(c) || [];
  const res = {};
  for (const [uname, uf] of Object.entries(units)) {
    const agg = new Map();
    for (const [c, a] of cells) {
      for (const u of uf(c)) {
        let r = agg.get(u); if (!r) { r = { obs: new Float64Array(NM), pred: new Float64Array(NM), raw: new Float64Array(NM), glob: new Float64Array(NM) }; agg.set(u, r); }
        for (const m of testMonths) {
          r.obs[m] += a[S.snpp * NM + m];
          r.pred[m] += predictModis(a, m, mT, mA, c);
          const nA = (avail[S.terra][m] ? 1 : 0) + (avail[S.aqua][m] ? 1 : 0);
          r.raw[m] += (a[S.terra * NM + m] + a[S.aqua * NM + m]) / Math.max(1, nA);
          r.glob[m] += ((avail[S.terra][m] ? kGT * a[S.terra * NM + m] : 0) + (avail[S.aqua][m] ? kGA * a[S.aqua * NM + m] : 0)) / Math.max(1, nA);
        }
      }
    }
    const mon = { pred: [], raw: [], glob: [] }, ann = { pred: [], raw: [], glob: [] }; let cov = 0, covN = 0; const perRegion = {};
    const years = [...new Set(testMonths.map(m => Math.floor(m / 12)))];
    for (const [u, r] of agg) {
      for (const m of testMonths) {
        const o = r.obs[m]; if (o < 10) continue;
        for (const k of ['pred', 'raw', 'glob']) mon[k].push(ape(r[k][m], o));
        const v = r.pred[m]; const b = UNC.find(x => v >= x.lo && v < x.hi) || UNC[UNC.length - 1];
        covN++; if (o >= v * Math.exp(b.q10) && o <= v * Math.exp(b.q90)) cov++;
      }
      for (const yy of years) {
        const ms = testMonths.filter(m => Math.floor(m / 12) === yy); const o = ms.reduce((s, m) => s + r.obs[m], 0); if (o < 100) continue;
        for (const k of ['pred', 'raw', 'glob']) ann[k].push(ape(ms.reduce((s, m) => s + r[k][m], 0), o));
        if (uname === 'region') { const nm = regionCells[u].id; (perRegion[nm] = perRegion[nm] || []).push(+(ms.reduce((s, m) => s + r.pred[m], 0) / o - 1).toFixed(3)); }
      }
    }
    const pack = e => ({ n: e.pred.length, harmonized: median2(e.pred), rawModis: median2(e.raw), globalRatio: median2(e.glob) });
    res[uname] = { monthly: pack(mon), annual: pack(ann), coverage80: covN ? cov / covN : null, coverageN: covN };
    if (uname === 'region') res[uname].annualSignedErrorByRegion = perRegion;
  }
  console.log(label, JSON.stringify(res));
  return res;
}
const OUTV = { lambda: LAMBDA, note: 'Median absolute % error of hold-out totals vs S-NPP VIIRS. monthly: unit-months with >=10 observed; annual: unit-years with >=100 observed. coverage80: share of hold-out monthly totals inside the app 80% range (block-level table from test A).' };
OUTV.testA = evalScales(range(mi(2012, 2), mi(2016, 12)), range(mi(2017, 1), mi(2019, 12)), LAMBDA, 'A');
OUTV.testB = evalScales(range(mi(2012, 2), mi(2019, 12)), range(mi(2020, 1), mi(2025, 12)), LAMBDA, 'B');
fs.writeFileSync(OUT, JSON.stringify(OUTV, null, 1));
console.log('wrote', OUT);
