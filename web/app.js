// FireRelay front end. No build step, no server: static files only, so the site keeps working
// unattended through judging. All harmonization arithmetic below mirrors pipeline/build.mjs.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmt = v => (v == null || isNaN(v)) ? '–' : Math.round(v).toLocaleString('en-US');
const fmt1 = v => (v == null || isNaN(v)) ? '–' : (v >= 10 ? v.toFixed(0) : v.toFixed(1));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const META = await (await fetch('data/meta.json')).json();
const PRESETS = await (await fetch('data/geo/presets.json')).json();
const NM = META.nMonths, Y0 = META.y0, NY = NM / 12, ERA = META.eras;
const AV = META.avail.map(s => Uint8Array.from(s, ch => (ch === '1' ? 1 : 0)));
const TILESET = new Set(META.tiles);
const WTILESET = new Set(META.weekly ? META.weekly.tiles : []);
const LASTDATE = META.lastDate ? new Date(META.lastDate + 'T00:00:00Z') : null;
const ym = m => [Y0 + Math.floor(m / 12), m % 12];
const mlabel = m => { const [y, mo] = ym(m); return `${MON[mo]} ${y}`; };
// partial month handling
const daysIn = m => { const [y, mo] = ym(m); return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); };
const PARTIAL = (LASTDATE && LASTDATE.getUTCDate() < daysIn(ERA.last)) ? ERA.last : -1;
const LASTFULL = PARTIAL >= 0 ? ERA.last - 1 : ERA.last;
const BASE_Y1 = ym(LASTFULL)[0] - 1;   // baseline: complete years 2001 .. (last full year)
if (LASTDATE) $('#fresh').textContent = `NASA FIRMS · data through ${LASTDATE.getUTCDate()} ${MON[LASTDATE.getUTCMonth()]} ${LASTDATE.getUTCFullYear()}`;

// ---------------- colour scales (ColorBrewer, colour-blind safe) ----------------
const SEQ = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
const ZERO = '#eceff3', NODATA = '#ffffff';
const DIV = [{ t: 0.25, c: '#2166ac', l: '< ¼ typical' }, { t: 0.5, c: '#67a9cf', l: '¼–½' }, { t: 0.8, c: '#d1e5f0', l: '½–0.8' }, { t: 1.25, c: '#f7f7f7', l: 'typical (0.8–1.25×)' }, { t: 2, c: '#fddbc7', l: '1.25–2×' }, { t: 4, c: '#ef8a62', l: '2–4×' }, { t: Infinity, c: '#b2182b', l: '> 4× typical' }];
function seqScale(values) {
  const nz = values.filter(v => v > 0 && isFinite(v)).sort((a, b) => a - b);
  if (!nz.length) return { color: () => ZERO, breaks: [] };
  const q = p => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  let br = [1, 2, 3, 4, 5, 6].map(i => q(i / 7));
  br = br.map((b, i) => Math.max(b, i ? br[i - 1] : 0));
  return { color: v => (v == null || isNaN(v)) ? NODATA : v <= 0.5 ? ZERO : SEQ[br.filter(b => v > b).length], breaks: br, max: nz[nz.length - 1] };
}
const divColor = r => (r == null || isNaN(r)) ? NODATA : DIV.find(d => r < d.t).c;

// ---------------- map ----------------
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
const map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 11, zoomSnap: 0.5, preferCanvas: true }).setView([2, 108], 4);
L.tileLayer(GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', { maxNativeZoom: 7, maxZoom: 11, attribution: 'Basemap: <a href="https://www.earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs">NASA GIBS</a> Blue Marble · boundaries: geoBoundaries' }).addTo(map);
const cellLayer = L.layerGroup().addTo(map), aoiLayer = L.layerGroup().addTo(map), drawLayer = L.layerGroup().addTo(map);
const canvasR = L.canvas({ padding: 0.3 });

// ---------------- geometry ----------------
function ringBBox(r) { let w = 180, e = -180, s = 90, n = -90; for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; } return { w, e, s, n }; }
function polysOf(g) { return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
function inRings(x, y, rings) { let ins = false; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
function cellWeights(geom) {
  const polys = polysOf(geom).map(p => ({ rings: p, bb: ringBBox(p[0]) }));
  const bb = polys.reduce((a, p) => ({ w: Math.min(a.w, p.bb.w), e: Math.max(a.e, p.bb.e), s: Math.min(a.s, p.bb.s), n: Math.max(a.n, p.bb.n) }), { w: 180, e: -180, s: 90, n: -90 });
  const r0 = Math.max(0, Math.floor((bb.s + 90) / 0.25)), r1 = Math.min(719, Math.floor((bb.n + 90) / 0.25));
  const c0 = Math.max(0, Math.floor((bb.w + 180) / 0.25)), c1 = Math.min(1439, Math.floor((bb.e + 180) / 0.25));
  const out = new Map(); const K = 4;
  for (let r = r0; r <= r1; r++) {
    const s = r * 0.25 - 90, n = s + 0.25;
    for (let c = c0; c <= c1; c++) {
      const w = c * 0.25 - 180, e = w + 0.25;
      const cand = polys.filter(p => p.bb.w <= e && p.bb.e >= w && p.bb.s <= n && p.bb.n >= s); if (!cand.length) continue;
      let hit = 0;
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { const x = w + (i + 0.5) * 0.25 / K, y = s + (j + 0.5) * 0.25 / K; if (cand.some(p => inRings(x, y, p.rings))) hit++; }
      if (hit) out.set(r * 1440 + c, hit / (K * K));
    }
  }
  return { weights: out, bbox: bb };
}
const cellArea = r => { const lat = (r + 0.5) * 0.25 - 90; return (0.25 * 111.32) ** 2 * Math.cos(lat * Math.PI / 180); };
function circlePoly(lat, lon, km, n = 72) { const ring = []; for (let i = 0; i <= n; i++) { const a = 2 * Math.PI * i / n; ring.push([lon + km / (111.32 * Math.cos(lat * Math.PI / 180)) * Math.cos(a), lat + km / 110.57 * Math.sin(a)]); } return { type: 'Polygon', coordinates: [ring] }; }
const boxPoly = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

// ---------------- data tiles ----------------
const tileCache = new Map();
async function gunzipIf(buf) { const u = new Uint8Array(buf, 0, 2); if (u[0] === 0x1f && u[1] === 0x8b) return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); return buf; }
function getTile(name) {
  if (!tileCache.has(name)) tileCache.set(name, (async () => {
    const buf = await gunzipIf(await (await fetch(`data/tiles/${name}.bin`)).arrayBuffer());
    const dv = new DataView(buf); const n = dv.getUint16(4, true), nm = dv.getUint16(6, true); const cells = new Map(); let o = 8;
    for (let i = 0; i < n; i++) {
      const li = dv.getUint16(o, true); const rS = dv.getFloat32(o + 2, true); const kT = new Float32Array(12), kA = new Float32Array(12);
      for (let j = 0; j < 12; j++) { kT[j] = dv.getFloat32(o + 6 + 4 * j, true); kA[j] = dv.getFloat32(o + 54 + 4 * j, true); }
      o += 102; cells.set(li, { kT, kA, rS, cn: new Uint32Array(buf.slice(o, o + 16 * nm)) }); o += 16 * nm;
    }
    return cells;
  })());
  return tileCache.get(name);
}
const wCache = new Map();
function getWTile(name) {
  if (!wCache.has(name)) wCache.set(name, (async () => {
    const buf = await gunzipIf(await (await fetch(`data/weekly/${name}.bin`)).arrayBuffer());
    const dv = new DataView(buf); const n = dv.getUint16(4, true), nw = dv.getUint16(6, true); const cells = new Map(); let o = 8;
    for (let i = 0; i < n; i++) { const li = dv.getUint16(o, true); o += 2; cells.set(li, new Float32Array(buf.slice(o, o + 4 * nw))); o += 4 * nw; }
    return cells;
  })());
  return wCache.get(name);
}
function harmCell(cell, m) {
  const cn = cell.cn;
  if (m >= ERA.n20Start && AV[3][m]) return cn[3 * NM + m];
  if (m >= ERA.snppStart && AV[2][m]) return cell.rS * cn[2 * NM + m];
  let s = 0, n = 0; const j = m % 12; if (AV[0][m]) { s += cell.kT[j] * cn[m]; n++; } if (AV[1][m]) { s += cell.kA[j] * cn[NM + m]; n++; }
  return n ? s / n : NaN;
}
const srcOf = m => (m >= ERA.n20Start && AV[3][m]) ? 3 : (m >= ERA.snppStart && AV[2][m]) ? 2 : (AV[0][m] || AV[1][m]) ? 1 : -1;
const SRCNAME = { 1: 'estimated from MODIS', 2: 'S-NPP VIIRS, cross-calibrated to NOAA-20', 3: 'NOAA-20 VIIRS, observed' };
function band(m, v) {
  const s = srcOf(m);
  if (s === 1) { const u = META.uncertainty.find(b => v >= b.lo && v < b.hi) || META.uncertainty[META.uncertainty.length - 1] || { q10: -0.5, q90: 0.5 }; return [v * Math.exp(u.q10), v * Math.exp(u.q90)]; }
  if (s === 2 && META.snppUnc) return [v * Math.exp(META.snppUnc.q10), v * Math.exp(META.snppUnc.q90)];
  return [v, v];
}

// ---------------- state ----------------
const state = { aoi: null, view: 'count', step: 'month', sel: null, series: null, cells: null, weekly: null, ts: { harm: true, modis: true, snpp: true, n20: true } };

async function computeSeries(weights) {
  const names = new Set(); for (const c of weights.keys()) { const r = Math.floor(c / 1440), cc = c % 1440; names.add(`${Math.floor(r / 20)}_${Math.floor(cc / 20)}`); }
  const tiles = new Map(await Promise.all([...names].filter(n => TILESET.has(n)).map(async n => [n, await getTile(n)])));
  const H = new Float64Array(NM), T = new Float64Array(NM), A = new Float64Array(NM), SN = new Float64Array(NM), N2 = new Float64Array(NM);
  const used = [];
  for (const [c, w] of weights) {
    const r = Math.floor(c / 1440), cc = c % 1440; const t = tiles.get(`${Math.floor(r / 20)}_${Math.floor(cc / 20)}`); if (!t) continue;
    const cell = t.get((r % 20) * 20 + (cc % 20)); if (!cell) continue;
    used.push([c, w, cell]);
    for (let m = 0; m < NM; m++) { const h = harmCell(cell, m); if (!isNaN(h)) H[m] += w * h; T[m] += w * cell.cn[m]; A[m] += w * cell.cn[NM + m]; SN[m] += w * cell.cn[2 * NM + m]; N2[m] += w * cell.cn[3 * NM + m]; }
  }
  for (let m = 0; m < NM; m++) { if (srcOf(m) < 0 || m > ERA.last) H[m] = NaN; }
  // climatology over complete baseline years
  const med = [], rank = new Array(NM).fill(null), nYears = [];
  for (let j = 0; j < 12; j++) {
    const vals = []; for (let y = 0; Y0 + y <= BASE_Y1; y++) { const v = H[y * 12 + j]; if (!isNaN(v)) vals.push(v); }
    vals.sort((a, b) => a - b); const h = vals.length >> 1; med.push(vals.length ? (vals.length % 2 ? vals[h] : (vals[h - 1] + vals[h]) / 2) : NaN);
    const all = []; for (let y = 0; y < NY; y++) { const m = y * 12 + j; if (!isNaN(H[m]) && m <= LASTFULL) all.push([m, H[m]]); }
    all.sort((a, b) => b[1] - a[1]); all.forEach(([m], i) => rank[m] = i + 1); nYears.push(all.length);
  }
  return { H, T, A, SN, N2, med, rank, nYears, used };
}

async function computeWeekly(geom) {
  if (!META.weekly) return null;
  const NWK = META.weekly.nWeeks, polys = polysOf(geom).map(p => ({ rings: p, bb: ringBBox(p[0]) }));
  const bb = polys.reduce((a, p) => ({ w: Math.min(a.w, p.bb.w), e: Math.max(a.e, p.bb.e), s: Math.min(a.s, p.bb.s), n: Math.max(a.n, p.bb.n) }), { w: 180, e: -180, s: 90, n: -90 });
  const W = new Float64Array(NWK); const need = new Map();
  for (let r = Math.max(0, Math.floor(bb.s + 90)); r <= Math.min(179, Math.floor(bb.n + 90)); r++) for (let c = Math.max(0, Math.floor(bb.w + 180)); c <= Math.min(359, Math.floor(bb.e + 180)); c++) {
    const s = r - 90, w = c - 180; let hit = 0; const K = 6;
    for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { const x = w + (i + 0.5) / K, y = s + (j + 0.5) / K; if (polys.some(p => p.bb.w <= x && p.bb.e >= x && p.bb.s <= y && p.bb.n >= y && inRings(x, y, p.rings))) hit++; }
    if (hit) need.set(r * 360 + c, hit / (K * K));
  }
  const names = new Set([...need.keys()].map(c => `${Math.floor(Math.floor(c / 360) / 10)}_${Math.floor((c % 360) / 10)}`));
  const tiles = new Map(await Promise.all([...names].filter(n => WTILESET.has(n)).map(async n => [n, await getWTile(n)])));
  for (const [c, wt] of need) { const r = Math.floor(c / 360), cc = c % 360; const t = tiles.get(`${Math.floor(r / 10)}_${Math.floor(cc / 10)}`); const a = t && t.get((r % 10) * 10 + (cc % 10)); if (!a) continue; for (let k = 0; k < NWK; k++) W[k] += wt * a[k]; }
  return W;
}

// ---------------- AOI selection ----------------
async function setAOI(aoi, { fit = true, push = true } = {}) {
  state.aoi = aoi; state.sel = null;
  $('#empty').hidden = true; $('#result').hidden = false;
  $('#aoiName').textContent = aoi.name; $('#aoiSub').textContent = 'Loading NASA FIRMS tiles…';
  $('#cards').innerHTML = ''; $('#calendar').innerHTML = '<div class="loading">Harmonizing 26 years of hotspots…</div>'; $('#ts').innerHTML = '';
  $$('.chip[data-preset]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === aoi.id)));
  aoiLayer.clearLayers(); cellLayer.clearLayers(); drawLayer.clearLayers();
  const gl = L.geoJSON(aoi.geometry, { style: { color: '#ffdd57', weight: 2.5, fill: false } }).addTo(aoiLayer);
  if (fit) map.fitBounds(gl.getBounds(), { padding: [20, 20], maxZoom: 8 });
  const { weights } = cellWeights(aoi.geometry);
  state.cells = weights;
  if (!weights.size) { $('#calendar').innerHTML = '<p class="hint">This area is smaller than one 0.25° cell centre sample. Draw a slightly larger area.</p>'; return; }
  const [series, weekly] = await Promise.all([computeSeries(weights), computeWeekly(aoi.geometry)]);
  if (state.aoi !== aoi) return; // superseded
  state.series = series; state.weekly = weekly;
  let area = 0; for (const [c, w] of weights) area += w * cellArea(Math.floor(c / 1440));
  $('#aoiSub').textContent = `≈ ${fmt(area)} km² · ${weights.size.toLocaleString()} cells of 0.25° · ${aoi.note || ''}`;
  drawCells();
  renderCards(); renderCalendar(); renderTS(); if (!$('#tableWrap').hidden) renderTable();
  if (push) writeHash();
}
function drawCells(monthSel = null) {
  cellLayer.clearLayers();
  const s = state.series; if (!s) return;
  let vals = null, sc = null;
  if (monthSel != null) { vals = new Map(s.used.map(([c, w, cell]) => [c, w * harmCell(cell, monthSel)])); sc = seqScale([...vals.values()]); }
  const big = state.cells.size > 4000;
  for (const [c, w] of state.cells) {
    const r = Math.floor(c / 1440), cc = c % 1440, s0 = r * 0.25 - 90, w0 = cc * 0.25 - 180;
    if (monthSel != null) { const v = vals.get(c) || 0; if (v <= 0.5) continue; L.rectangle([[s0, w0], [s0 + 0.25, w0 + 0.25]], { renderer: canvasR, weight: 0, fillColor: sc.color(v), fillOpacity: 0.85, interactive: false }).addTo(cellLayer); }
    else if (!big) L.rectangle([[s0, w0], [s0 + 0.25, w0 + 0.25]], { renderer: canvasR, weight: 0.6, color: '#ffffff', opacity: 0.55, fill: false, interactive: false }).addTo(cellLayer);
  }
  $('#mapLegend').innerHTML = monthSel != null ? `<b>${mlabel(monthSel)}</b>: hotspots per 0.25° cell (NOAA-20 equivalent), darker = more. <a href="#" id="clearSel">Show counted cells</a>` : (big ? 'Large area: cell outlines hidden for speed.' : 'Outlined squares are the 0.25° cells counted for your area.');
  const cl = $('#clearSel'); if (cl) cl.onclick = e => { e.preventDefault(); state.sel = null; drawCells(); renderCalendar(); };
}

// ---------------- status cards ----------------
function classify(v, med, rank) {
  if (isNaN(v)) return ['b-typical', 'no data'];
  const r = med > 0 ? v / med : (v > 0 ? Infinity : 1);
  if (rank && rank <= 3 && r >= 1.5) return ['b-extreme', rank === 1 ? 'record' : `top ${rank}`];
  if (r >= 1.25) return ['b-above', 'above typical'];
  if (r <= 0.8) return ['b-below', 'below typical'];
  return ['b-typical', 'typical'];
}
function renderCards() {
  const s = state.series, out = [];
  const m = LASTFULL, [y, mo] = ym(m), v = s.H[m], md = s.med[mo];
  const [cls, lab] = classify(v, md, s.rank[m]);
  out.push(`<div class="card"><div class="k">${MONL[mo]} ${y} · latest full month</div><div class="v">${fmt(v)}</div><div class="d"><span class="badge ${cls}">${lab}</span> ${md > 0 ? (v / md).toFixed(1) + '× the typical ' + MON[mo] : ''}<br>rank ${s.rank[m] ?? '–'} of ${s.nYears[mo]} ${MONL[mo]}s since ${Y0}</div></div>`);
  if (PARTIAL >= 0) { const [py, pm] = ym(PARTIAL); const d = LASTDATE.getUTCDate(); out.push(`<div class="card"><div class="k">${MON[pm]} 1–${d}, ${py} · so far</div><div class="v">${fmt(s.H[PARTIAL])}</div><div class="d">Partial month (NRT data). A typical full ${MONL[pm]} has ${fmt(s.med[pm])}.</div></div>`); }
  // year to date
  const ytdEnd = mo; let cur = 0; for (let j = 0; j <= ytdEnd; j++) cur += s.H[(y - Y0) * 12 + j];
  const past = []; for (let yy = Y0; yy <= BASE_Y1; yy++) { let t = 0; for (let j = 0; j <= ytdEnd; j++) t += s.H[(yy - Y0) * 12 + j]; past.push(t); }
  const sp = [...past].sort((a, b) => a - b); const pmed = sp[sp.length >> 1]; const prank = past.filter(t => t > cur).length + 1;
  const [c2, l2] = classify(cur, pmed, prank);
  out.push(`<div class="card"><div class="k">${y} so far · Jan to ${MON[mo]}</div><div class="v">${fmt(cur)}</div><div class="d"><span class="badge ${c2}">${l2}</span> ${pmed > 0 ? (cur / pmed).toFixed(1) + '× typical' : ''}<br>rank ${prank} of ${past.length + 1} years</div></div>`);
  // season
  const mx = Math.max(...s.med.filter(x => !isNaN(x)));
  if (mx > 0) {
    const peak = s.med.indexOf(mx); const inS = s.med.map(x => x >= 0.5 * mx);
    let a = peak, b = peak; while (inS[(a + 11) % 12] && (a + 11) % 12 !== peak) a = (a + 11) % 12; while (inS[(b + 1) % 12] && (b + 1) % 12 !== a) b = (b + 1) % 12;
    let share = 0, tot = s.med.reduce((p, q) => p + (q || 0), 0); for (let j = a; ; j = (j + 1) % 12) { share += s.med[j] || 0; if (j === b) break; }
    out.push(`<div class="card"><div class="k">Typical burning season</div><div class="v">${a === b ? MON[a] : MON[a] + '–' + MON[b]}</div><div class="d">Peak month ${MONL[peak]}; these months hold ${Math.round(100 * share / tot)}% of a typical year (medians ${Y0}–${BASE_Y1}).</div></div>`);
  } else out.push(`<div class="card"><div class="k">Typical burning season</div><div class="v">–</div><div class="d">Too few hotspots to define a season.</div></div>`);
  $('#cards').innerHTML = out.join('');
}

// ---------------- calendar ----------------
const tip = $('#tip');
function showTip(html, ev) { tip.innerHTML = html; tip.hidden = false; const x = Math.min(window.innerWidth - 340, ev.clientX + 14), y = Math.min(window.innerHeight - tip.offsetHeight - 10, ev.clientY + 14); tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
const hideTip = () => { tip.hidden = true; };
function cellTip(m) {
  const s = state.series, [y, mo] = ym(m), v = s.H[m], src = srcOf(m);
  if (m > ERA.last || isNaN(v)) return `<b>${MONL[mo]} ${y}</b><br><span class="s">No data yet.</span>`;
  const [lo, hi] = band(m, v), md = s.med[mo];
  return `<b>${MONL[mo]} ${y}${m === PARTIAL ? ' (1–' + LASTDATE.getUTCDate() + ', partial)' : ''}</b><br>${fmt(v)} hotspots, NOAA-20 equivalent` + (src !== 3 ? `<br><span class="s">80% range ${fmt(lo)} to ${fmt(hi)}</span>` : '') +
    `<br>${md > 0 ? (v / md).toFixed(2) + '× typical ' + MON[mo] + ' (' + fmt(md) + ')' : 'typical ' + MON[mo] + ': ' + fmt(md)}` + (s.rank[m] ? ` · rank ${s.rank[m]}/${s.nYears[mo]}` : '') +
    `<br><span class="s">Source: ${SRCNAME[src]}</span><br><span class="s">Raw: Terra ${fmt(s.T[m])} · Aqua ${fmt(s.A[m])} · S-NPP ${AV[2][m] ? fmt(s.SN[m]) : '–'} · NOAA-20 ${AV[3][m] ? fmt(s.N2[m]) : '–'}</span>`;
}
function renderCalendar() {
  if (state.step === 'week') return renderWeekly();
  const s = state.series, el = $('#calendar'); const W = Math.max(520, el.clientWidth || 720);
  const LW = 44, RW = 92, gap = 2, cw = (W - LW - RW - gap * 12) / 12, ch = 17, top = 18;
  const rows = NY + 2; const H = top + rows * (ch + gap) + 6;
  const sc = seqScale(Array.from(s.H).filter((v, m) => m <= ERA.last));
  const annual = []; for (let y = 0; y < NY; y++) { let t = 0, ok = true; for (let j = 0; j < 12; j++) { const v = s.H[y * 12 + j]; if (isNaN(v)) ok = false; else t += v; } annual.push({ t, ok }); }
  const amax = Math.max(1, ...annual.map(a => a.t));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="grid" aria-label="Monthly burning calendar ${Y0} to ${Y0 + NY - 1}, rows are years, columns are months"><defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="rgba(255,255,255,.75)" stroke-width="1.4"/></pattern></defs>`;
  MON.forEach((mn, j) => svg += `<text x="${LW + j * (cw + gap) + cw / 2}" y="12" font-size="11" text-anchor="middle" fill="#4a5563">${mn}</text>`);
  svg += `<text x="${W - RW + 4}" y="12" font-size="11" fill="#4a5563">Year total</text>`;
  for (let y = 0; y < NY; y++) {
    const yy = top + y * (ch + gap);
    svg += `<text x="${LW - 6}" y="${yy + ch - 4}" font-size="11" text-anchor="end" fill="#4a5563">${Y0 + y}</text>`;
    for (let j = 0; j < 12; j++) {
      const m = y * 12 + j, v = s.H[m], x = LW + j * (cw + gap);
      const fill = m > ERA.last ? NODATA : state.view === 'anom' ? divColor(s.med[j] > 0 ? v / s.med[j] : (v > 0 ? 9 : 1)) : sc.color(v);
      const lbl = `${MONL[j]} ${Y0 + y}: ${isNaN(v) || m > ERA.last ? 'no data' : fmt(v) + ' hotspots'}`;
      svg += `<rect class="cell${state.sel === m ? ' sel' : ''}" data-m="${m}" x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="2" fill="${fill}" ${m > ERA.last ? 'stroke="#e3e7ec" stroke-dasharray="2 2"' : ''} tabindex="${m === LASTFULL ? 0 : -1}" role="gridcell" aria-label="${lbl}"/>`;
      if (srcOf(m) === 1 && m <= ERA.last) svg += `<rect x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="2" fill="url(#hatch)" pointer-events="none"/>`;
      if (m === PARTIAL) svg += `<rect x="${x + 0.5}" y="${yy + 0.5}" width="${cw - 1}" height="${ch - 1}" rx="2" fill="none" stroke="#11161c" stroke-dasharray="3 2" pointer-events="none"/>`;
      if (s.rank[m] === 1 && s.nYears[j] >= 10 && v > 0) svg += `<circle cx="${x + cw - 5}" cy="${yy + 5}" r="2.6" fill="#fff" stroke="#11161c" stroke-width="1" pointer-events="none"/>`;
    }
    const a = annual[y]; const bw = (RW - 44) * a.t / amax;
    svg += `<rect x="${W - RW + 4}" y="${yy + 3}" width="${bw}" height="${ch - 6}" fill="${a.ok ? '#8a96a5' : '#c9d1da'}"/><text x="${W - RW + 8 + bw}" y="${yy + ch - 4}" font-size="10" fill="#4a5563">${a.t ? (a.t >= 1e4 ? Math.round(a.t / 1e3) + 'k' : fmt(a.t)) : ''}${a.ok ? '' : '*'}</text>`;
  }
  const ty = top + (NY + 0.4) * (ch + gap);
  svg += `<text x="${LW - 6}" y="${ty + ch - 4}" font-size="10.5" text-anchor="end" fill="#11161c" font-weight="600">Typical</text>`;
  for (let j = 0; j < 12; j++) { const x = LW + j * (cw + gap), v = s.med[j]; svg += `<rect x="${x}" y="${ty}" width="${cw}" height="${ch}" rx="2" fill="${state.view === 'anom' ? '#f7f7f7' : sc.color(v)}" stroke="#11161c" stroke-width=".6"><title>Typical ${MONL[j]} (median ${Y0}–${BASE_Y1}): ${fmt(v)}</title></rect>`; if (cw > 34) svg += `<text x="${x + cw / 2}" y="${ty + ch - 4.5}" font-size="9.5" text-anchor="middle" fill="${sc.breaks.length && v > sc.breaks[3] && state.view !== 'anom' ? '#fff' : '#11161c'}" pointer-events="none">${v >= 1e4 ? Math.round(v / 1e3) + 'k' : fmt(v)}</text>`; }
  svg += '</svg>';
  el.innerHTML = svg;
  // legend
  let lg = '';
  if (state.view === 'anom') lg = DIV.map(d => `<span class="sw"><i style="background:${d.c}"></i>${d.l}</span>`).join('');
  else { const b = [0, ...sc.breaks]; lg = `<span class="sw"><i style="background:${ZERO}"></i>0</span>` + SEQ.map((c, i) => `<span class="sw"><i style="background:${c}"></i>${i === 0 ? '1' : fmt(b[i])}${i < SEQ.length - 1 ? '–' + fmt(b[i + 1]) : '+'}</span>`).join(''); }
  lg += `<span class="sw"><i style="background:#fd8d3c;background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.8) 0 1.5px,transparent 1.5px 4px)"></i>estimated from MODIS (before Feb 2012)</span><span class="sw"><i style="background:#fff;border:1px dashed #11161c"></i>partial month</span><span class="sw">○ record for that month</span><span class="sw">* incomplete year</span>`;
  $('#calLegend').innerHTML = lg;
  wireGrid(el.querySelector('svg'));
}
function wireGrid(svg) {
  svg.addEventListener('mousemove', e => { const t = e.target.closest('.cell'); if (t) showTip(cellTip(+t.dataset.m), e); else hideTip(); });
  svg.addEventListener('mouseleave', hideTip);
  svg.addEventListener('click', e => { const t = e.target.closest('.cell'); if (t) selectMonth(+t.dataset.m); });
  svg.addEventListener('keydown', e => {
    const t = e.target.closest('.cell'); if (!t) return; let m = +t.dataset.m;
    const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 }[e.key];
    if (mv) { e.preventDefault(); m = Math.max(0, Math.min(NM - 1, m + mv)); const n = svg.querySelector(`.cell[data-m="${m}"]`); if (n) { t.tabIndex = -1; n.tabIndex = 0; n.focus(); const r = n.getBoundingClientRect(); showTip(cellTip(m), { clientX: r.right, clientY: r.bottom }); } }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMonth(m); }
    if (e.key === 'Escape') hideTip();
  });
}
function selectMonth(m) { if (m > ERA.last) return; state.sel = state.sel === m ? null : m; drawCells(state.sel); $$('#calendar .cell').forEach(c => c.classList.toggle('sel', +c.dataset.m === state.sel)); }

function renderWeekly() {
  const el = $('#calendar'), W8 = state.weekly;
  if (!W8) { el.innerHTML = '<p class="hint">Weekly data is not available in this build.</p>'; return; }
  const NWK = META.weekly.nWeeks, PER = 53, W = Math.max(520, el.clientWidth || 720), LW = 44, RW = 10, cw = (W - LW - RW) / PER, ch = 13, gap = 1.5, top = 18;
  const H = top + NY * (ch + gap) + 4;
  const lastW = META.weekly.lastWeek;
  const vals = Array.from(W8).filter((v, k) => k <= lastW);
  const sc = seqScale(vals);
  // weekly typical: median by week-of-year over baseline years
  const wmed = []; for (let k = 0; k < PER; k++) { const xs = []; for (let y = 0; Y0 + y <= BASE_Y1; y++) xs.push(W8[y * PER + k]); xs.sort((a, b) => a - b); wmed.push(xs[xs.length >> 1]); }
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly burning calendar, rows are years, columns are weeks of the year">`;
  MON.forEach((mn, j) => { const wk = Math.floor((new Date(Date.UTC(2001, j, 1)) - new Date(Date.UTC(2001, 0, 1))) / 864e5 / 7); svg += `<text x="${LW + wk * cw}" y="12" font-size="10.5" fill="#4a5563">${mn}</text>`; });
  for (let y = 0; y < NY; y++) {
    const yy = top + y * (ch + gap); svg += `<text x="${LW - 6}" y="${yy + ch - 3}" font-size="10" text-anchor="end" fill="#4a5563">${Y0 + y}</text>`;
    for (let k = 0; k < PER; k++) {
      const idx = y * PER + k; if (idx > lastW) continue; const v = W8[idx];
      const fill = state.view === 'anom' ? divColor(wmed[k] > 0 ? v / wmed[k] : (v > 0 ? 9 : 1)) : sc.color(v);
      svg += `<rect class="wk" data-k="${idx}" x="${LW + k * cw}" y="${yy}" width="${Math.max(1, cw - gap)}" height="${ch}" fill="${fill}"/>`;
      if (META.weekly.modisBefore && idx < META.weekly.modisBefore) svg += `<rect x="${LW + k * cw}" y="${yy}" width="${Math.max(1, cw - gap)}" height="${ch}" fill="url(#hatchw)" pointer-events="none"/>`;
    }
  }
  svg = svg.replace('role="img"', 'role="img"') + `<defs><pattern id="hatchw" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="rgba(255,255,255,.7)" stroke-width="1.2"/></pattern></defs></svg>`;
  el.innerHTML = svg;
  const b = [0, ...sc.breaks];
  $('#calLegend').innerHTML = (state.view === 'anom' ? DIV.map(d => `<span class="sw"><i style="background:${d.c}"></i>${d.l}</span>`).join('') : `<span class="sw"><i style="background:${ZERO}"></i>0</span>` + SEQ.map((c, i) => `<span class="sw"><i style="background:${c}"></i>${i === 0 ? '1' : fmt(b[i])}${i < SEQ.length - 1 ? '–' + fmt(b[i + 1]) : '+'}</span>`).join('')) + `<span class="sw">Weekly view: 1° cells, weeks start 1 Jan; hatched = estimated from MODIS. Colours are relative to this area, so busy weeks stand out like a contribution graph.</span>`;
  const svgEl = el.querySelector('svg');
  svgEl.addEventListener('mousemove', e => { const t = e.target.closest('.wk'); if (!t) return hideTip(); const k = +t.dataset.k, y = Y0 + Math.floor(k / PER), w = k % PER; const d0 = new Date(Date.UTC(y, 0, 1 + 7 * w)), d1 = new Date(Math.min(Date.UTC(y, 11, 31), Date.UTC(y, 0, 7 + 7 * w))); showTip(`<b>${d0.getUTCDate()} ${MON[d0.getUTCMonth()]} to ${d1.getUTCDate()} ${MON[d1.getUTCMonth()]} ${y}</b><br>${fmt(W8[k])} hotspots (NOAA-20 equivalent)<br><span class="s">Typical for this week: ${fmt(wmed[w])}</span>`, e); });
  svgEl.addEventListener('mouseleave', hideTip);
}

// ---------------- table (accessible alternative) ----------------
function renderTable() {
  const s = state.series; let h = '<table><caption class="hint" style="text-align:left;padding:6px">Monthly hotspots, NOAA-20 VIIRS equivalent</caption><thead><tr><th scope="col">Year</th>' + MON.map(m => `<th scope="col">${m}</th>`).join('') + '<th scope="col">Total</th></tr></thead><tbody>';
  for (let y = 0; y < NY; y++) { let t = 0; h += `<tr><th scope="row">${Y0 + y}</th>`; for (let j = 0; j < 12; j++) { const m = y * 12 + j, v = s.H[m]; if (!isNaN(v) && m <= ERA.last) t += v; h += `<td>${m > ERA.last || isNaN(v) ? '' : fmt(v)}${srcOf(m) === 1 && m <= ERA.last ? '<sup>e</sup>' : ''}</td>`; } h += `<td>${fmt(t)}</td></tr>`; }
  h += `<tr><th scope="row">Typical</th>${s.med.map(v => `<td><b>${fmt(v)}</b></td>`).join('')}<td></td></tr></tbody></table><p class="hint" style="padding:0 6px">e = estimated from MODIS.</p>`;
  $('#tableWrap').innerHTML = h;
}

// ---------------- time series ----------------
function renderTS() {
  const s = state.series, el = $('#ts'), W = Math.max(520, el.clientWidth || 720), Hh = 230, L0 = 56, R0 = 10, T0 = 22, B0 = 24;
  const n = ERA.last + 1, X = m => L0 + (W - L0 - R0) * m / (n - 1);
  const modisAvg = m => { const k = AV[0][m] + AV[1][m]; return k ? (s.T[m] + s.A[m]) / k : NaN; };
  const lines = [];
  if (state.ts.harm) lines.push({ c: '#b10026', w: 2, v: m => s.H[m] });
  if (state.ts.modis) lines.push({ c: '#6b7685', w: 1.2, d: '4 3', v: m => modisAvg(m) });
  if (state.ts.snpp) lines.push({ c: '#0b5cad', w: 1.1, v: m => AV[2][m] ? s.SN[m] : NaN });
  if (state.ts.n20) lines.push({ c: '#0f8a7e', w: 1.1, v: m => AV[3][m] ? s.N2[m] : NaN });
  let ymax = 1; for (let m = 0; m < n; m++) { for (const l of lines) { const v = l.v(m); if (v > ymax) ymax = v; } if (state.ts.harm && srcOf(m) !== 3) { const b = band(m, s.H[m]); if (b[1] > ymax && b[1] < 3 * ymax) ymax = b[1]; } }
  ymax *= 1.05; const Y = v => T0 + (Hh - T0 - B0) * (1 - v / ymax);
  let svg = `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Monthly time series of harmonized and raw sensor hotspot counts">`;
  const eras = [[0, ERA.snppStart, '#fff4e0', 'MODIS era · estimated'], [ERA.snppStart, ERA.n20Start, '#eaf2fb', 'S-NPP era · cross-calibrated'], [ERA.n20Start, n, '#e8f6f3', 'NOAA-20 era · observed']];
  for (const [a, b, c, t] of eras) { svg += `<rect x="${X(a)}" y="${T0}" width="${X(Math.min(b, n - 1)) - X(a)}" height="${Hh - T0 - B0}" fill="${c}"/><text x="${X(a) + 4}" y="${T0 - 6}" font-size="10.5" fill="#4a5563">${t}</text>`; }
  for (let i = 0; i <= 4; i++) { const v = ymax * i / 4; svg += `<line x1="${L0}" x2="${W - R0}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e7ec"/><text x="${L0 - 6}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#6b7685">${v >= 1e4 ? Math.round(v / 1e3) + 'k' : fmt(v)}</text>`; }
  for (let y = 0; y < NY; y += 5) svg += `<text x="${X(y * 12)}" y="${Hh - 6}" font-size="10" fill="#6b7685">${Y0 + y}</text>`;
  if (state.ts.harm) { let up = '', dn = ''; for (let m = 0; m < ERA.snppStart; m++) { const [lo, hi] = band(m, s.H[m]); up += `${X(m)},${Y(Math.min(hi, ymax))} `; dn = `${X(m)},${Y(lo)} ` + dn; } svg += `<polygon points="${up}${dn}" fill="rgba(177,0,38,.16)"/>`; }
  for (const l of lines) { let d = '', pen = false; for (let m = 0; m < n; m++) { const v = l.v(m); if (isNaN(v)) { pen = false; continue; } d += (pen ? 'L' : 'M') + X(m).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; } svg += `<path d="${d}" fill="none" stroke="${l.c}" stroke-width="${l.w}" ${l.d ? `stroke-dasharray="${l.d}"` : ''}/>`; }
  svg += `<line id="tsx" x1="0" x2="0" y1="${T0}" y2="${Hh - B0}" stroke="#11161c" stroke-width=".8" visibility="hidden"/><rect id="tshit" x="${L0}" y="${T0}" width="${W - L0 - R0}" height="${Hh - T0 - B0}" fill="transparent"/></svg>`;
  el.innerHTML = svg;
  const sv = el.querySelector('svg'), hit = sv.querySelector('#tshit'), xl = sv.querySelector('#tsx');
  hit.addEventListener('mousemove', e => { const r = sv.getBoundingClientRect(); const px = (e.clientX - r.left) * W / r.width; const m = Math.max(0, Math.min(n - 1, Math.round((px - L0) / (W - L0 - R0) * (n - 1)))); xl.setAttribute('x1', X(m)); xl.setAttribute('x2', X(m)); xl.setAttribute('visibility', 'visible'); showTip(cellTip(m) + `<br><span class="s">MODIS per-satellite average: ${fmt(modisAvg(m))}</span>`, e); });
  hit.addEventListener('mouseleave', () => { hideTip(); xl.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('click', e => { const r = sv.getBoundingClientRect(); const px = (e.clientX - r.left) * W / r.width; selectMonth(Math.max(0, Math.min(n - 1, Math.round((px - L0) / (W - L0 - R0) * (n - 1))))); });
  const gk = META.globalK; $('#tsCaption').textContent = `Dashed grey is raw MODIS (average per satellite). Worldwide, S-NPP VIIRS records about ${gk.aqua.toFixed(0)}× as many hotspots as Aqua MODIS and ${gk.terra.toFixed(0)}× as many as Terra MODIS in the same months, so naively stitching the two records creates a false jump in 2012. The red line is the harmonized record; the shaded band is the 80% uncertainty of the MODIS-based estimate, measured on held-out years.`;
}
function initToggles() {
  const defs = [['harm', 'Harmonized (NOAA-20 equivalent)', '#b10026'], ['modis', 'Raw MODIS (per satellite)', '#6b7685'], ['snpp', 'Raw S-NPP VIIRS', '#0b5cad'], ['n20', 'Raw NOAA-20 VIIRS', '#0f8a7e']];
  $('#tsToggles').innerHTML = defs.map(([k, l, c]) => `<label><input type="checkbox" data-k="${k}" ${state.ts[k] ? 'checked' : ''}><i style="background:${c}"></i>${l}</label>`).join('');
  $$('#tsToggles input').forEach(i => i.onchange = () => { state.ts[i.dataset.k] = i.checked; renderTS(); });
}

// ---------------- downloads & sharing ----------------
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const slug = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
$('#dlCsv').onclick = () => {
  const s = state.series, a = state.aoi; if (!s) return;
  const rows = [`# FireRelay harmonized burning calendar · ${a.name}`, `# Units: active-fire hotspots in NOAA-20 VIIRS 375 m equivalent (nominal+high confidence, presumed vegetation fires, FIRMS type 0)`, `# Source data: NASA FIRMS standard archive (MODIS C6.1, VIIRS S-NPP/NOAA-20 375 m) + near-real-time for the latest months; built ${META.built.slice(0, 10)}; data through ${META.lastDate || ''}`, `# lower80/upper80: 80% uncertainty from hold-out validation (MODIS era) or S-NPP to NOAA-20 cross-calibration; 0.25 deg cells weighted by fraction inside area`, `# Method and validation: see method.html`,
    'year,month,hotspots_harmonized,lower80,upper80,source,partial_month,raw_terra_modis,raw_aqua_modis,raw_snpp_viirs,raw_noaa20_viirs,typical_median,ratio_to_typical,rank_among_same_month,years_ranked'];
  for (let m = 0; m <= ERA.last; m++) { const [y, j] = ym(m), v = s.H[m]; if (isNaN(v)) continue; const [lo, hi] = band(m, v); rows.push([y, j + 1, v.toFixed(1), lo.toFixed(1), hi.toFixed(1), ['', 'modis_estimate', 'snpp_crosscal', 'noaa20_observed'][srcOf(m)], m === PARTIAL ? 1 : 0, s.T[m].toFixed(1), s.A[m].toFixed(1), AV[2][m] ? s.SN[m].toFixed(1) : '', AV[3][m] ? s.N2[m].toFixed(1) : '', s.med[j].toFixed(1), s.med[j] > 0 ? (v / s.med[j]).toFixed(3) : '', s.rank[m] ?? '', s.nYears[j]].join(',')); }
  download(`firerelay_${slug(a.name)}_monthly.csv`, rows.join('\n'), 'text/csv');
};
$('#dlGeo').onclick = () => { const a = state.aoi; if (a) download(`firerelay_${slug(a.name)}_area.geojson`, JSON.stringify({ type: 'Feature', properties: { name: a.name }, geometry: a.geometry }), 'application/geo+json'); };
$('#share').onclick = async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); $('#share').textContent = '✓ Copied'; } catch { prompt('Copy this link', location.href); } setTimeout(() => $('#share').textContent = '🔗 Link', 1500); };
function writeHash() {
  const a = state.aoi; if (!a) return; let h = '';
  if (a.kind === 'preset') h = 'p=' + a.id; else if (a.kind === 'circle') h = `c=${a.lat.toFixed(3)},${a.lon.toFixed(3)},${a.km}`; else if (a.kind === 'box') h = 'b=' + a.box.map(v => v.toFixed(3)).join(','); else h = 'g=' + a.geometry.coordinates[0].map(([x, y]) => x.toFixed(3) + ',' + y.toFixed(3)).join(';');
  h += `&v=${state.view}&s=${state.step}`; history.replaceState(null, '', '#' + h);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1)); if (q.get('v')) setSeg('view', q.get('v')); if (q.get('s')) setSeg('step', q.get('s'));
  if (q.get('p')) { const p = PRESETS.find(x => x.id === q.get('p')); if (p) return presetAOI(p); }
  if (q.get('c')) { const [lat, lon, km] = q.get('c').split(',').map(Number); return circleAOI(lat, lon, km); }
  if (q.get('b')) { const [w, s, e, n] = q.get('b').split(',').map(Number); return boxAOI(w, s, e, n); }
  if (q.get('g')) { const ring = q.get('g').split(';').map(p => p.split(',').map(Number)); return { kind: 'poly', id: 'custom', name: 'Custom area', geometry: { type: 'Polygon', coordinates: [ring] } }; }
  return null;
}
const presetAOI = p => ({ kind: 'preset', id: p.id, name: p.name, note: p.note, geometry: p.geometry });
const circleAOI = (lat, lon, km) => ({ kind: 'circle', id: 'circle', lat, lon, km, name: `${km} km around ${lat.toFixed(2)}, ${lon.toFixed(2)}`, geometry: circlePoly(lat, lon, km) });
const boxAOI = (w, s, e, n) => ({ kind: 'box', id: 'box', box: [w, s, e, n], name: `Box ${w.toFixed(1)}, ${s.toFixed(1)} to ${e.toFixed(1)}, ${n.toFixed(1)}`, geometry: boxPoly(w, s, e, n) });

// ---------------- UI wiring ----------------
function setSeg(kind, val) { state[kind] = val; $$(`.seg button[data-${kind}]`).forEach(b => b.setAttribute('aria-checked', String(b.dataset[kind] === val))); }
$$('.seg button[data-view]').forEach(b => b.onclick = () => { setSeg('view', b.dataset.view); if (state.series) { renderCalendar(); writeHash(); } });
$$('.seg button[data-step]').forEach(b => b.onclick = () => { setSeg('step', b.dataset.step); if (state.series) { renderCalendar(); writeHash(); } });
$('#tableBtn').onclick = () => { const w = $('#tableWrap'); w.hidden = !w.hidden; $('#tableBtn').setAttribute('aria-expanded', String(!w.hidden)); $('#tableBtn').textContent = w.hidden ? 'Show as table' : 'Hide table'; if (!w.hidden) renderTable(); };
$$('.tabs button').forEach(b => b.onclick = () => { $$('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b))); $$('.tabpanel').forEach(p => p.hidden = p.id !== 'tab-' + b.dataset.tab); });
// presets
const groups = [...new Set(PRESETS.map(p => p.group))];
$('#presetList').innerHTML = groups.map(g => `<div><h3>${esc(g)}</h3><div class="chips">${PRESETS.filter(p => p.group === g).map(p => `<button class="chip" data-preset="${p.id}" title="${esc(p.note)}">${esc(p.name)}</button>`).join('')}</div></div>`).join('');
$('#quickStart').innerHTML = ['riau', 'central-kalimantan', 'cordoba', 'california'].map(id => { const p = PRESETS.find(x => x.id === id); return p ? `<button class="chip" data-preset="${p.id}">${esc(p.name)}</button>` : ''; }).join('');
document.addEventListener('click', e => { const b = e.target.closest('[data-preset]'); if (b) { const p = PRESETS.find(x => x.id === b.dataset.preset); if (p) setAOI(presetAOI(p)); } });
$('#pointForm').onsubmit = e => { e.preventDefault(); setAOI(circleAOI(+$('#inLat').value, +$('#inLon').value, +$('#inRad').value)); };
$('#boxForm').onsubmit = e => { e.preventDefault(); const w = +$('#inW').value, s = +$('#inS').value, ee = +$('#inE').value, n = +$('#inN').value; if (ee <= w || n <= s) return alert('East must be greater than West and North greater than South.'); setAOI(boxAOI(w, s, ee, n)); };
// drawing
let mode = null, start = null, temp = null, pts = [];
function endDraw() { mode = null; map.dragging.enable(); map.doubleClickZoom.enable(); map.getContainer().classList.remove('fb-draw'); $('#drawRect').classList.remove('active'); $('#drawPoly').classList.remove('active'); }
$('#drawRect').onclick = () => { endDraw(); mode = 'rect'; map.dragging.disable(); map.getContainer().classList.add('fb-draw'); $('#drawRect').classList.add('active'); $('#drawHint').textContent = 'Press and drag on the map to draw a rectangle.'; };
$('#drawPoly').onclick = () => { endDraw(); mode = 'poly'; pts = []; map.doubleClickZoom.disable(); map.getContainer().classList.add('fb-draw'); $('#drawPoly').classList.add('active'); $('#drawHint').textContent = 'Click to add corners; double-click to finish.'; };
$('#drawClear').onclick = () => { endDraw(); drawLayer.clearLayers(); };
map.on('mousedown', e => { if (mode !== 'rect') return; start = e.latlng; temp = L.rectangle([start, start], { color: '#ffdd57', weight: 2, fillOpacity: 0.1 }).addTo(drawLayer); });
map.on('mousemove', e => { if (mode === 'rect' && start && temp) temp.setBounds([start, e.latlng]); if (mode === 'poly' && pts.length && temp) temp.setLatLngs([...pts, e.latlng]); });
map.on('mouseup', e => { if (mode !== 'rect' || !start) return; const b = L.latLngBounds(start, e.latlng); start = null; endDraw(); if (Math.abs(b.getEast() - b.getWest()) < 0.2 || Math.abs(b.getNorth() - b.getSouth()) < 0.2) { drawLayer.clearLayers(); $('#drawHint').textContent = 'Too small: draw at least about 25 km across.'; return; } setAOI({ ...boxAOI(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()), name: 'Drawn rectangle' }); });
map.on('click', e => { if (mode !== 'poly') return; pts.push(e.latlng); if (!temp) temp = L.polyline(pts, { color: '#ffdd57', weight: 2 }).addTo(drawLayer); else temp.setLatLngs(pts); });
map.on('dblclick', e => { if (mode !== 'poly') return; endDraw(); if (pts.length < 3) return; const ring = pts.map(p => [p.lng, p.lat]); ring.push(ring[0]); temp = null; setAOI({ kind: 'poly', id: 'custom', name: 'Drawn polygon', geometry: { type: 'Polygon', coordinates: [ring] } }); pts = []; });

initToggles();
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.series) { renderCalendar(); renderTS(); } }, 150); });
const fromHash = readHash();
setAOI(fromHash || presetAOI(PRESETS.find(p => p.id === 'riau') || PRESETS[0]), { push: !!fromHash });
window.addEventListener('hashchange', () => { const a = readHash(); if (a && (!state.aoi || JSON.stringify(a.geometry) !== JSON.stringify(state.aoi.geometry))) setAOI(a, { push: false }); else if (state.series) renderCalendar(); });
