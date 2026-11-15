// FireRelay front end. Static files only, no build step. The harmonization arithmetic here mirrors pipeline/build.mjs.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmt = v => (v == null || isNaN(v)) ? '–' : Math.round(v).toLocaleString('en-US');
const kfmt = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : fmt(v);
const xfmt = r => !isFinite(r) ? '–' : r >= 10 ? r.toFixed(0) : r.toFixed(1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ord = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const [META, PRESETS] = await Promise.all([fetch('data/meta.json').then(r => r.json()), fetch('data/geo/presets.json').then(r => r.json())]);
const NM = META.nMonths, Y0 = META.y0, NY = NM / 12, ERA = META.eras;
const AV = META.avail.map(s => Uint8Array.from(s, ch => (ch === '1' ? 1 : 0)));
const TILESET = new Set(META.tiles), WTILESET = new Set(META.weekly ? META.weekly.tiles : []);
const LASTDATE = META.lastDate ? new Date(META.lastDate + 'T00:00:00Z') : null;
const ym = m => [Y0 + Math.floor(m / 12), m % 12];
const daysIn = m => { const [y, mo] = ym(m); return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(); };
const PARTIAL = (LASTDATE && LASTDATE.getUTCDate() < daysIn(ERA.last)) ? ERA.last : -1;
const LASTFULL = PARTIAL >= 0 ? ERA.last - 1 : ERA.last;
const BASE_Y1 = ym(LASTFULL)[0] - 1;
const SRCNAME = { 1: 'MODIS · ESTIMATED', 2: 'S-NPP · CROSS-CALIBRATED', 3: 'NOAA-20 · OBSERVED' };
const SRCSHORT = { 1: 'MODIS · EST.', 2: 'S-NPP · CAL.', 3: 'NOAA-20 · OBS.' };
const SRCLONG = { 1: 'estimated from Terra and Aqua MODIS', 2: 'S-NPP VIIRS, cross-calibrated to NOAA-20', 3: 'NOAA-20 VIIRS, observed' };
if (LASTDATE) $('#aoiBuilt').textContent = `DATA TO ${LASTDATE.getUTCDate()} ${MON[LASTDATE.getUTCMonth()].toUpperCase()} ${LASTDATE.getUTCFullYear()}`;
fetch('data/validation_scales.json').then(r => r.json()).then(v => { $('#stErr').textContent = Math.round(100 * v.testA.region.annual.harmonized) + '%'; }).catch(() => {});
fetch('data/build_stats.json').then(r => r.json()).then(s => { $('#stDet').textContent = Math.round(s.rows / 1e6) + 'M'; }).catch(() => {});

// ---------------- colour ----------------
const PAL = {
  dark: { stops: ['#3a1a12', '#661d10', '#9a2610', '#cc3d10', '#f0641c', '#fb9a37', '#ffc96e', '#ffe7b8'], zero: '#191816', nodata: '#0f0f0e', empty: 'rgba(236,235,228,0.035)', hatch: 'rgba(11,11,10,.55)', glow: true, alpha: [0.62, 0.3],
    div: ['#2d5b9c', '#3b6fae', '#24334a', '#22211e', '#5e2a17', '#b23e16', '#ff6a2b'], sens: { 1: '#8a6a4a', 2: '#5b8fd9', 3: '#7fb27a' }, ink: '#ecebe4', ink3: '#6d6b64', ink4: '#3a3935', rule: '#1f1e1b', line: '#2b2a27', bg: '#0b0b0a', amber: '#ffb547', cold: '#5b8fd9', bars: { 1: '#b5471c', 2: '#d9531f', 3: '#ff6a2b' }, aoi: '#ecebe4', recFill: '#ecebe4', recStroke: 'none' },
  light: { stops: ['#f7e3cf', '#f3c49b', '#ec9a62', '#e06e37', '#c8481c', '#a12e10', '#741d0a', '#401005'], zero: '#e7e3d9', nodata: '#efece5', empty: 'rgba(23,22,15,0.045)', hatch: 'rgba(255,255,255,.62)', glow: false, alpha: [0.78, 0.2],
    div: ['#2f62b0', '#6f95cf', '#cbd7ea', '#e3dfd5', '#f1c3a4', '#de7646', '#b3300f'], sens: { 1: '#a8865a', 2: '#2f62b0', 3: '#4b8a46' }, ink: '#17160f', ink3: '#8c887d', ink4: '#c9c4b8', rule: '#e0dbd0', line: '#d3cec2', bg: '#f4f2ec', amber: '#b5600f', cold: '#2f62b0', bars: { 1: '#e39a74', 2: '#da6a3e', 3: '#c8401a' }, aoi: '#17160f', recFill: '#ffffff', recStroke: '#17160f' },
};
const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
let P = PAL[theme()];
let STOPS = P.stops, ZERO = P.zero, NODATA = P.nodata;
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
let STOPRGB = STOPS.map(hex);
function rampRGB(t) { t = clamp(t, 0, 1); const x = t * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i, a = STOPRGB[i], b = STOPRGB[i + 1]; return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f)); }
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
let GRAD = `linear-gradient(90deg,${STOPS.join(',')})`;
// quantile-rank scale: even use of the ramp across the area's own distribution
function makeScale(vals) {
  const nz = Float64Array.from(vals.filter(v => v > 0.5 && isFinite(v))).sort();
  const rank = v => { let lo = 0, hi = nz.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nz[mid] < v) lo = mid + 1; else hi = mid; } return nz.length > 1 ? lo / (nz.length - 1) : 1; };
  const q = p => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0;
  return { t: v => (v == null || isNaN(v) || v <= 0.5) ? -1 : 0.06 + 0.94 * rank(v), color: v => (v == null || isNaN(v)) ? NODATA : v <= 0.5 ? ZERO : rgb(rampRGB(0.06 + 0.94 * rank(v))), q, n: nz.length };
}
const DIVT = [0.25, 0.5, 0.8, 1.25, 2, 4, Infinity], DIVL = ['<¼', '¼–½', '½–0.8', 'typical', '1.25–2×', '2–4×', '>4×'];
let DIV = DIVT.map((t, i) => ({ t, c: P.div[i], l: DIVL[i] }));
function applyPalette() { P = PAL[theme()]; STOPS = P.stops; ZERO = P.zero; NODATA = P.nodata; STOPRGB = STOPS.map(hex); GRAD = `linear-gradient(90deg,${STOPS.join(',')})`; DIV = DIVT.map((t, i) => ({ t, c: P.div[i], l: DIVL[i] })); }
const divColor = r => (r == null || isNaN(r)) ? NODATA : DIV.find(d => r < d.t).c;

// ---------------- map ----------------
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/';
const map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 10, zoomSnap: 0.25, zoomControl: false, attributionControl: true }).setView([0, 110], 4);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer(GIBS + 'BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', { maxNativeZoom: 7, maxZoom: 10, attribution: 'NASA GIBS Blue Marble · geoBoundaries · Leaflet' }).addTo(map);
map.attributionControl.setPrefix(false);
map.createPane('heat'); map.getPane('heat').style.zIndex = 350;
const aoiLayer = L.layerGroup().addTo(map), drawLayer = L.layerGroup().addTo(map);
const HeatLayer = L.Layer.extend({
  onAdd(m) { this._m = m; this._c = L.DomUtil.create('canvas', 'leaflet-zoom-hide'); m.getPane('heat').appendChild(this._c); m.on('moveend zoomend resize viewreset', this._reset, this); this._reset(); },
  setData(d) { this._d = d; this._draw(); },
  _reset() { const m = this._m, s = m.getSize(), dpr = window.devicePixelRatio || 1; L.DomUtil.setPosition(this._c, m.containerPointToLayerPoint([0, 0])); this._c.width = s.x * dpr; this._c.height = s.y * dpr; this._c.style.width = s.x + 'px'; this._c.style.height = s.y + 'px'; this._draw(); },
  _draw() {
    const d = this._d, c = this._c, m = this._m; if (!c) return; const x = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, c.width, c.height); if (!d) return;
    const glow = [];
    for (const it of d.cells) {
      const r = Math.floor(it.c / 1440), cc = it.c % 1440, s0 = r * 0.25 - 90, w0 = cc * 0.25 - 180;
      const p1 = m.latLngToContainerPoint([s0 + 0.25, w0]), p2 = m.latLngToContainerPoint([s0, w0 + 0.25]);
      const w = p2.x - p1.x, h = p2.y - p1.y; const g = Math.max(0.6, Math.min(1.5, w * 0.06));
      if (it.t < 0) { x.fillStyle = P.empty; x.fillRect(p1.x + g, p1.y + g, w - 2 * g, h - 2 * g); continue; }
      const col = rampRGB(it.t); x.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${P.alpha[0] + P.alpha[1] * it.t})`; x.fillRect(p1.x + g, p1.y + g, w - 2 * g, h - 2 * g);
      if (d.est && w > 6) { x.strokeStyle = P.hatch; x.lineWidth = 1; x.save(); x.beginPath(); x.rect(p1.x + g, p1.y + g, w - 2 * g, h - 2 * g); x.clip(); x.beginPath(); for (let k = -h; k < w; k += 5) { x.moveTo(p1.x + k, p1.y + h); x.lineTo(p1.x + k + h, p1.y); } x.stroke(); x.restore(); }
      if (P.glow && it.t > 0.9) glow.push([p1.x + w / 2, p1.y + h / 2, Math.max(w, h), col]);
    }
    x.globalCompositeOperation = 'lighter';
    for (const [cx, cy, s, col] of glow) { const gr = x.createRadialGradient(cx, cy, 0, cx, cy, s * 1.4); gr.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},.16)`); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(cx - s * 1.4, cy - s * 1.4, s * 2.8, s * 2.8); }
    x.globalCompositeOperation = 'source-over';
  },
});
const heat = new HeatLayer().addTo(map);
const peak = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="pulse"><i></i><i></i><b></b></div>', iconSize: [0, 0] }), interactive: false, keyboard: false });
map.on('mousemove', e => {
  const lat = e.latlng.lat, lon = L.Util.wrapNum(e.latlng.lng, [-180, 180], true); $('#mapXY').textContent = `LAT ${lat.toFixed(3)}  ·  LON ${lon.toFixed(3)}`;
  if (mode || !state.byCell) return; const c = Math.floor((lat + 90) / 0.25) * 1440 + Math.floor((lon + 180) / 0.25), hit = state.byCell.get(c);
  if (!hit) { if (tip.dataset.src === 'map') hideTip(); return; }
  const [w, cell] = hit, m = state.m, [y, mo] = ym(m), v = cell ? w * harmCell(cell, m) : 0;
  let typ = []; if (cell) for (let yy = 0; Y0 + yy <= BASE_Y1; yy++) typ.push(w * harmCell(cell, yy * 12 + mo)); typ = typ.filter(isFinite).sort((p, q) => p - q); const tm = typ.length ? typ[typ.length >> 1] : 0;
  showTip(`<div class="tt"><i style="background:${state.cellScale.color(v)}"></i>${MON[mo]} ${y} · one cell</div><div class="tv"><b>${fmt(v)}</b> HOTSPOTS${tm > 0 ? ` · <b>${xfmt(v / tm)}×</b> ITS TYPICAL ${MON[mo].toUpperCase()}` : ''}<br>CELL ${(Math.floor((lat + 90) / 0.25) * 0.25 - 90).toFixed(2)}°, ${(Math.floor((lon + 180) / 0.25) * 0.25 - 180).toFixed(2)}° · ${Math.round(w * 100)}% INSIDE AREA</div>`, e.originalEvent); tip.dataset.src = 'map';
});
map.on('mouseout', () => { if (tip.dataset.src === 'map') hideTip(); });

// ---------------- geometry ----------------
function ringBBox(r) { let w = 180, e = -180, s = 90, n = -90; for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; } return { w, e, s, n }; }
const polysOf = g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
function inRings(x, y, rings) { let ins = false; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
function polyPrep(geom) { const polys = polysOf(geom).map(p => ({ rings: p, bb: ringBBox(p[0]) })); const bb = polys.reduce((a, p) => ({ w: Math.min(a.w, p.bb.w), e: Math.max(a.e, p.bb.e), s: Math.min(a.s, p.bb.s), n: Math.max(a.n, p.bb.n) }), { w: 180, e: -180, s: 90, n: -90 }); return { polys, bb }; }
function cellWeights(geom) {
  const { polys, bb } = polyPrep(geom); const out = new Map(), K = 4;
  for (let r = Math.max(0, Math.floor((bb.s + 90) / 0.25)); r <= Math.min(719, Math.floor((bb.n + 90) / 0.25)); r++) {
    const s = r * 0.25 - 90, n = s + 0.25;
    for (let c = Math.max(0, Math.floor((bb.w + 180) / 0.25)); c <= Math.min(1439, Math.floor((bb.e + 180) / 0.25)); c++) {
      const w = c * 0.25 - 180, e = w + 0.25; const cand = polys.filter(p => p.bb.w <= e && p.bb.e >= w && p.bb.s <= n && p.bb.n >= s); if (!cand.length) continue;
      let hit = 0; for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { const x = w + (i + 0.5) * 0.25 / K, y = s + (j + 0.5) * 0.25 / K; if (cand.some(p => inRings(x, y, p.rings))) hit++; }
      if (hit) out.set(r * 1440 + c, hit / (K * K));
    }
  }
  return out;
}
const cellArea = r => { const lat = (r + 0.5) * 0.25 - 90; return (0.25 * 111.32) ** 2 * Math.cos(lat * Math.PI / 180); };
function circlePoly(lat, lon, km, n = 72) { const ring = []; for (let i = 0; i <= n; i++) { const a = 2 * Math.PI * i / n; ring.push([lon + km / (111.32 * Math.cos(lat * Math.PI / 180)) * Math.cos(a), lat + km / 110.57 * Math.sin(a)]); } return { type: 'Polygon', coordinates: [ring] }; }
const boxPoly = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

// ---------------- data tiles ----------------
const tileCache = new Map(), wCache = new Map();
async function gunzipIf(buf) { const u = new Uint8Array(buf, 0, 2); if (u[0] === 0x1f && u[1] === 0x8b) return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); return buf; }
function getTile(name) {
  if (!tileCache.has(name)) tileCache.set(name, (async () => {
    const buf = await gunzipIf(await (await fetch(`data/tiles/${name}.bin`)).arrayBuffer()); const dv = new DataView(buf);
    const n = dv.getUint16(4, true), nm = dv.getUint16(6, true); const cells = new Map(); let o = 8;
    for (let i = 0; i < n; i++) { const li = dv.getUint16(o, true), rS = dv.getFloat32(o + 2, true), kT = new Float32Array(12), kA = new Float32Array(12); for (let j = 0; j < 12; j++) { kT[j] = dv.getFloat32(o + 6 + 4 * j, true); kA[j] = dv.getFloat32(o + 54 + 4 * j, true); } o += 102; cells.set(li, { kT, kA, rS, cn: new Uint32Array(buf.slice(o, o + 16 * nm)) }); o += 16 * nm; }
    return cells;
  })());
  return tileCache.get(name);
}
function getWTile(name) {
  if (!wCache.has(name)) wCache.set(name, (async () => {
    const buf = await gunzipIf(await (await fetch(`data/weekly/${name}.bin`)).arrayBuffer()); const dv = new DataView(buf);
    const n = dv.getUint16(4, true), nw = dv.getUint16(6, true); const cells = new Map(); let o = 8;
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
function band(m, v) {
  const s = srcOf(m);
  if (s === 1) { const u = META.uncertainty.find(b => v >= b.lo && v < b.hi) || META.uncertainty[META.uncertainty.length - 1]; return [v * Math.exp(u.q10), v * Math.exp(u.q90)]; }
  if (s === 2 && META.snppUnc) return [v * Math.exp(META.snppUnc.q10), v * Math.exp(META.snppUnc.q90)];
  return [v, v];
}

// ---------------- state ----------------
const state = { aoi: null, view: 'count', step: 'month', m: LASTFULL, series: null, cells: null, weekly: null, playing: false, speed: 8, cmp: false, cellScale: null, monthScale: null };

async function computeSeries(weights) {
  const names = new Set(); for (const c of weights.keys()) { const r = Math.floor(c / 1440), cc = c % 1440; names.add(`${Math.floor(r / 20)}_${Math.floor(cc / 20)}`); }
  const tiles = new Map(await Promise.all([...names].filter(n => TILESET.has(n)).map(async n => [n, await getTile(n)])));
  const H = new Float64Array(NM), T = new Float64Array(NM), A = new Float64Array(NM), SN = new Float64Array(NM), N2 = new Float64Array(NM), used = [];
  for (const [c, w] of weights) {
    const r = Math.floor(c / 1440), cc = c % 1440; const t = tiles.get(`${Math.floor(r / 20)}_${Math.floor(cc / 20)}`); const cell = t && t.get((r % 20) * 20 + (cc % 20));
    if (!cell) { used.push([c, w, null]); continue; }
    used.push([c, w, cell]);
    for (let m = 0; m < NM; m++) { const h = harmCell(cell, m); if (!isNaN(h)) H[m] += w * h; T[m] += w * cell.cn[m]; A[m] += w * cell.cn[NM + m]; SN[m] += w * cell.cn[2 * NM + m]; N2[m] += w * cell.cn[3 * NM + m]; }
  }
  for (let m = 0; m < NM; m++) if (srcOf(m) < 0 || m > ERA.last) H[m] = NaN;
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
  const NWK = META.weekly.nWeeks, { polys, bb } = polyPrep(geom), W = new Float64Array(NWK), need = new Map();
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

// ---------------- number tweening ----------------
function tween(el, to, f = fmt, dur = 750) {
  const from = +el.dataset.v || 0; el.dataset.v = to; const t0 = performance.now();
  if (!isFinite(to)) { el.firstChild.nodeValue = f(to); return; }
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4); el.firstChild.nodeValue = f(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------------- AOI ----------------
let aoiSeq = 0;
async function setAOI(aoi, { fit = true, push = true } = {}) {
  const seq = ++aoiSeq; stop();
  state.aoi = aoi;
  $$('.file').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === aoi.id)));
  const pi = PRESETS.findIndex(p => p.id === aoi.id);
  $('#aoiKick').textContent = pi >= 0 ? `AREA / ${String(pi + 1).padStart(2, '0')} · ${PRESETS[pi].group.split('(')[0].trim().toUpperCase()}` : `AREA / CUSTOM · ${aoi.kind.toUpperCase()}`;
  $('#aoiName').textContent = aoi.name; $('#aoiDeck').textContent = aoi.note || 'Your own area. Every number below is computed in your browser from the harmonized record.';
  $('#aoiMeta').textContent = 'HARMONIZING 26 YEARS…';
  $('#calendar').innerHTML = '<div class="loading">HARMONIZING 26 YEARS OF HOTSPOTS</div>';
  aoiLayer.clearLayers(); drawLayer.clearLayers(); map.removeLayer(peak);
  const gl = L.geoJSON(aoi.geometry, { style: { color: P.aoi, weight: 1.2, opacity: 0.85, fill: false, dashArray: '3 4' }, interactive: false }).addTo(aoiLayer);
  if (fit) map.flyToBounds(gl.getBounds(), { padding: [30, 30], maxZoom: 8, duration: 1.1 });
  const weights = cellWeights(aoi.geometry); state.cells = weights;
  if (!weights.size) { $('#calendar').innerHTML = '<p class="note">This area is smaller than one 0.25° cell. Draw a slightly larger area.</p>'; return; }
  const [series, weekly] = await Promise.all([computeSeries(weights), computeWeekly(aoi.geometry)]);
  if (seq !== aoiSeq) return;
  state.series = series; state.weekly = weekly; state.byCell = new Map(series.used.map(([c, w, cell]) => [c, [w, cell]]));
  // scales: map cells across all months; calendar across monthly totals
  const cv = []; const stepM = Math.max(1, Math.round(series.used.length * ERA.last / 400000));
  for (const [, w, cell] of series.used) if (cell) for (let m = 0; m <= ERA.last; m += stepM) { const v = harmCell(cell, m); if (v > 0) cv.push(w * v); }
  state.cellScale = makeScale(cv);
  state.monthScale = makeScale(Array.from(series.H).filter((v, m) => m <= ERA.last));
  let area = 0; for (const [c, w] of weights) area += w * cellArea(Math.floor(c / 1440));
  $('#aoiMeta').textContent = `≈ ${fmt(area)} KM²  ·  ${weights.size.toLocaleString()} CELLS  ·  2001–${ym(ERA.last)[0]}`;
  renderMetrics(); renderCalendar(); buildTimeline(); renderMapRamp();
  setMonth(state.m, { force: true });
  renderChecks(seq);
  if (!$('#tableWrap').hidden) renderTable();
  if (push) writeHash();
}

// ---------------- checks: measured hold-out error, naive stitch, outlook ----------------
let HOLD = null;
async function loadHold() {
  if (HOLD) return HOLD;
  HOLD = (async () => { const buf = await gunzipIf(await (await fetch('data/holdout_blocks.bin')).arrayBuffer()); const u = new Uint32Array(buf instanceof ArrayBuffer ? buf : buf.buffer); const map = new Map(); for (let i = 0; i < u.length; i += 121) map.set(u[i], u.subarray(i + 1, i + 121)); return map; })();
  return HOLD;
}
const medianOf = xs => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const pctS = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(100 * v)) + '%';
async function renderChecks(seq) {
  const s = state.series; if (!s) return;
  const yr = (arr, y0, y1) => { let t = 0, n = 0; for (let y = y0; y <= y1; y++) { let a = 0; for (let j = 0; j < 12; j++) { const m = (y - Y0) * 12 + j; const v = arr(m); a += isNaN(v) ? 0 : v; } t += a; n++; } return t / n; };
  const raw = m => m >= ERA.n20Start && AV[3][m] ? s.N2[m] : m >= ERA.snppStart && AV[2][m] ? s.SN[m] : ((AV[0][m] ? s.T[m] : 0) + (AV[1][m] ? s.A[m] : 0)) / Math.max(1, (AV[0][m] ? 1 : 0) + (AV[1][m] ? 1 : 0));
  const nv = yr(raw, 2013, 2017) / yr(raw, 2006, 2010) - 1, hv = yr(m => s.H[m], 2013, 2017) / yr(m => s.H[m], 2006, 2010) - 1;
  if (isFinite(nv) && isFinite(hv)) { $('#ckNaive').innerHTML = `${pctS(nv)} <span style="color:var(--ink4)">→</span> <em>${pctS(hv)}</em>`; $('#ckNaiveD').textContent = `Change from 2006–10 to 2013–17. A raw stitch says ${pctS(nv)}; harmonized, it is ${pctS(hv)}.`; }
  else { $('#ckNaive').textContent = '–'; $('#ckNaiveD').textContent = 'Too few fires here to compare.'; }
  const nxt = [1, 2, 3].map(k => (LASTFULL + k) % 12); const tot = nxt.reduce((a, j) => a + (s.med[j] || 0), 0), yrTot = s.med.reduce((a, v) => a + (v || 0), 0);
  const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  $('#ckOut').textContent = `≈ ${fmt(tot)}`; $('#ckOutD').textContent = `Typical ${MN[nxt[0]]}–${MN[nxt[2]]} total, ${yrTot ? Math.round(100 * tot / yrTot) : 0}% of a usual year. History, not a forecast.`;
  $('#ckErr').textContent = '…'; $('#ckErrD').textContent = 'Loading the hold-out test…';
  const H = await loadHold(); if (seq !== aoiSeq) return;
  const bw = new Map(); for (const [c, w] of state.cells) { const r = Math.floor(c / 1440), cc = c % 1440; const b = Math.floor(r / 4) * 360 + Math.floor(cc / 4); bw.set(b, (bw.get(b) || 0) + w / 16); }
  const o = new Float64Array(36), p = new Float64Array(36), rw = new Float64Array(36), oB = new Float64Array(6), pB = new Float64Array(6);
  for (const [b, w] of bw) { const v = H.get(b); if (!v) continue; for (let i = 0; i < 36; i++) { o[i] += w * v[i]; p[i] += w * v[36 + i]; rw[i] += w * v[72 + i]; } for (let y = 0; y < 6; y++) { oB[y] += w * v[108 + y]; pB[y] += w * v[114 + y]; } }
  const em = [], er = []; for (let i = 0; i < 36; i++) if (o[i] >= 10) { em.push(Math.abs(p[i] - o[i]) / (o[i] + 1)); er.push(Math.abs(rw[i] - o[i]) / (o[i] + 1)); }
  const ey = []; for (let y = 0; y < 3; y++) { let so = 0, sp = 0; for (let j = 0; j < 12; j++) { so += o[y * 12 + j]; sp += p[y * 12 + j]; } if (so >= 100) ey.push(Math.abs(sp - so) / (so + 1)); }
  for (let y = 0; y < 6; y++) if (oB[y] >= 100) ey.push(Math.abs(pB[y] - oB[y]) / (oB[y] + 1));
  if (em.length < 6 && ey.length < 2) { $('#ckErr').textContent = 'n/a'; $('#ckErrD').textContent = 'Too few fires here in 2017–2025 to measure the error.'; return; }
  const my = medianOf(ey), mm = medianOf(em), mr = medianOf(er);
  $('#ckErr').innerHTML = isFinite(my) ? `${Math.round(100 * my)}% <span style="font-size:11px;color:var(--ink3)" class="mono">YEARLY</span>` : `${Math.round(100 * mm)}% <span style="font-size:11px;color:var(--ink3)" class="mono">MONTHLY</span>`;
  $('#ckErrD').textContent = `Median error here on years the model never saw (2017–2025, ${ey.length} years)${isFinite(mm) ? `. Monthly: ${Math.round(100 * mm)}%, raw MODIS ${Math.round(100 * mr)}%` : ''}.`;
}

// ---------------- month cursor ----------------
function setMonth(m, { force = false } = {}) {
  m = clamp(m, 0, ERA.last); if (m === state.m && !force) return; state.m = m;
  const s = state.series; if (!s) return;
  const est = srcOf(m) === 1;
  // map
  const cells = []; let best = null;
  for (const [c, w, cell] of s.used) { const v = cell ? w * harmCell(cell, m) : 0; const t = state.cellScale.t(v); cells.push({ c, t }); if (v > 0 && (!best || v > best.v)) best = { c, v }; }
  heat.setData({ cells, est });
  if (best && best.v >= 1) { const r = Math.floor(best.c / 1440), cc = best.c % 1440, ll = [r * 0.25 - 90 + 0.125, cc * 0.25 - 180 + 0.125]; peak.setLatLng(ll); if (!map.hasLayer(peak)) peak.addTo(map); const el = peak.getElement(), b = el && el.querySelector('b'); if (b) { b.textContent = `PEAK CELL ${fmt(best.v)}`; const px = map.latLngToContainerPoint(ll).x; el.querySelector('.pulse').classList.toggle('left', px > map.getSize().x - 170); } } else map.removeLayer(peak);
  const [y, mo] = ym(m);
  $('#mapK1').textContent = `${MON[mo].toUpperCase()} ${y}`; $('#mapK2').textContent = SRCNAME[srcOf(m)] || '';
  // calendar highlight
  $$('#calendar .cell.sel').forEach(c => c.classList.remove('sel')); const cc = $(`#calendar .cell[data-m="${m}"]`); if (cc) cc.classList.add('sel');
  // timeline
  updateTimeline(); renderNarration();
}
function narrationFor(m) {
  const s = state.series, [y, mo] = ym(m), v = s.H[m], md = s.med[mo], r = md > 0 ? v / md : (v > 0 ? Infinity : 1), rk = s.rank[m], n = s.nYears[mo];
  if (m === ERA.snppStart) return 'The first handover: S-NPP VIIRS takes the baton from MODIS. Without calibration, fire counts would jump here.';
  if (m === ERA.n20Start) return 'The second handover: NOAA-20 takes over. From here every month is observed, with no model in between.';
  if (m === PARTIAL) return `${MONL[mo]} so far, to the ${ord(LASTDATE.getUTCDate())}: ${fmt(v)} hotspots, against ${fmt(md)} in a typical full ${MONL[mo]}.`;
  if (isNaN(v)) return 'No satellite data for this month.';
  if (md < 3 && v < 3) return `Almost no fire, as usual for ${MONL[mo]} here.`;
  if (rk === 1 && n >= 10 && r >= 1.25) return `The most fire in any ${MONL[mo]} since ${Y0}: ${xfmt(r)}× a typical ${MONL[mo]}.`;
  if (rk && rk <= 3 && r >= 1.5) return `${xfmt(r)}× a typical ${MONL[mo]}, the ${ord(rk)} highest in ${n} years.`;
  if (r >= 2) return `${xfmt(r)}× a typical ${MONL[mo]}. A bad month for fire.`;
  if (r >= 1.25) return `Busier than a typical ${MONL[mo]}: ${xfmt(r)}× the usual count.`;
  if (r <= 0.25) return `A very quiet ${MONL[mo]}: about a ${r < 0.15 ? 'tenth' : 'fifth'} of the usual fire.`;
  if (r <= 0.8) return `Quieter than usual: ${xfmt(r)}× a typical ${MONL[mo]}.`;
  return `Close to a typical ${MONL[mo]} for this area.`;
}
function renderNarration() {
  const m = state.m, [y, mo] = ym(m), s = state.series, v = s.H[m], src = srcOf(m);
  const [lo, hi] = band(m, v);
  $('#narrT').innerHTML = `<span>${MON[mo].toUpperCase()} ${y}  ·  ${fmt(v)} HOTSPOTS${src !== 3 && !isNaN(v) ? `  ·  80% ${kfmt(lo)}–${kfmt(hi)}` : ''}</span><span class="src">${SRCSHORT[src] || ''}</span>`;
  const el = $('#narr'), txt = narrationFor(m);
  if (el.textContent !== txt) { if (state.playing) el.textContent = txt; else { el.classList.add('fade'); setTimeout(() => { el.textContent = txt; el.classList.remove('fade'); }, 140); } }
}

// ---------------- metrics ----------------
function classify(v, md, rk) { const r = md > 0 ? v / md : (v > 0 ? Infinity : 1); if (rk && rk <= 3 && r >= 1.5) return ['hot', rk === 1 ? 'RECORD' : `${ord(rk).toUpperCase()} HIGHEST`]; if (r >= 1.25) return ['hot', `RANK ${rk}`]; if (r <= 0.8) return ['cool', `RANK ${rk}`]; return ['', `RANK ${rk}`]; }
function renderMetrics() {
  const s = state.series, m = LASTFULL, [y, mo] = ym(m), v = s.H[m], md = s.med[mo]; const [c1, l1] = classify(v, md, s.rank[m]);
  let cur = 0; for (let j = 0; j <= mo; j++) cur += s.H[(y - Y0) * 12 + j];
  const past = []; for (let yy = Y0; yy <= BASE_Y1; yy++) { let t = 0; for (let j = 0; j <= mo; j++) t += s.H[(yy - Y0) * 12 + j]; past.push(t); }
  const sp = [...past].sort((a, b) => a - b), pmed = sp[sp.length >> 1], prank = past.filter(t => t > cur).length + 1; const [c2, l2] = classify(cur, pmed, prank);
  const mx = Math.max(...s.med.filter(x => !isNaN(x))); let season = '–', share = 0, peakM = 0;
  if (mx > 0) { peakM = s.med.indexOf(mx); const inS = s.med.map(x => x >= 0.5 * mx); let a = peakM, b = peakM; while (inS[(a + 11) % 12] && (a + 11) % 12 !== peakM) a = (a + 11) % 12; while (inS[(b + 1) % 12] && (b + 1) % 12 !== a) b = (b + 1) % 12; const tot = s.med.reduce((p, q) => p + (q || 0), 0); for (let j = a; ; j = (j + 1) % 12) { share += s.med[j] || 0; if (j === b) break; } share = Math.round(100 * share / tot); season = a === b ? MON[a] : `${MON[a]}–${MON[b]}`; }
  $('#metrics').innerHTML = `
    <div class="metric"><div class="v"><span id="mv1">0</span><small>${md > 0 ? xfmt(v / md) + '×' : ''}</small></div><div class="l"><b>${MON[mo].toUpperCase()} ${y}</b><br><span class="${c1}">${l1}</span> OF ${s.nYears[mo]}</div></div>
    <div class="metric"><div class="v"><span id="mv2">0</span><small>${pmed > 0 ? xfmt(cur / pmed) + '×' : ''}</small></div><div class="l"><b>${y} TO ${MON[mo].toUpperCase()}</b><br><span class="${c2}">${l2}</span> OF ${past.length + 1}</div></div>
    <div class="metric"><div class="v" style="font-size:24px;padding-top:4px"><span>${season}</span></div><div class="l"><b>TYPICAL SEASON</b><br>${share}% OF A YEAR · PEAK ${MON[peakM].toUpperCase()}</div></div>`;
  $('#mv1').dataset.v = 0; $('#mv2').dataset.v = 0; tween($('#mv1'), v); tween($('#mv2'), cur);
}

// ---------------- calendar ----------------
const tip = $('#tip');
function showTip(html, ev) { tip.dataset.src = ''; tip.innerHTML = html; tip.hidden = false; const x = Math.min(window.innerWidth - 336, ev.clientX + 16), y = Math.min(window.innerHeight - tip.offsetHeight - 12, ev.clientY + 16); tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
const hideTip = () => { tip.hidden = true; };
function cellTip(m) {
  const s = state.series, [y, mo] = ym(m), v = s.H[m], src = srcOf(m);
  if (m > ERA.last || isNaN(v)) return `<div class="tt">${MONL[mo]} ${y}</div><div class="tv">No data yet.</div>`;
  const [lo, hi] = band(m, v), md = s.med[mo], col = state.view === 'anom' ? divColor(md > 0 ? v / md : 9) : state.monthScale.color(v);
  return `<div class="tt"><i style="background:${col}"></i>${MONL[mo]} ${y}${m === PARTIAL ? ' <span style="font-size:12px;color:var(--ink3)">(partial)</span>' : ''}</div>` +
    `<div class="tv"><b>${fmt(v)}</b> HOTSPOTS · NOAA-20 UNITS${src !== 3 ? `<br>80% RANGE ${fmt(lo)}–${fmt(hi)}` : ''}<br>${md > 0 ? `<b>${xfmt(v / md)}×</b> A TYPICAL ${MON[mo].toUpperCase()} (${fmt(md)})` : `TYPICAL ${MON[mo].toUpperCase()}: ${fmt(md)}`}${s.rank[m] ? ` · RANK ${s.rank[m]}/${s.nYears[mo]}` : ''}</div>` +
    `<div class="ts">${SRCLONG[src]}<br>RAW · TERRA ${fmt(s.T[m])} · AQUA ${fmt(s.A[m])} · S-NPP ${AV[2][m] ? fmt(s.SN[m]) : '–'} · NOAA-20 ${AV[3][m] ? fmt(s.N2[m]) : '–'}</div>`;
}
const SENSCOL = new Proxy({}, { get: (_, k) => P.sens[k] });
function renderCalendar() {
  if (state.step === 'week') return renderWeekly();
  const s = state.series, el = $('#calendar'), W = Math.max(380, el.clientWidth || 430);
  const LW = 40, RW = 62, gap = 1.6, cw = (W - LW - RW - gap * 11) / 12, ch = 10.6, top = 15, NYR = NY;
  const H = top + (NYR + 1.6) * (ch + gap) + 4, sc = state.monthScale;
  const annual = []; for (let y = 0; y < NYR; y++) { let t = 0, ok = true; for (let j = 0; j < 12; j++) { const v = s.H[y * 12 + j]; if (isNaN(v) || y * 12 + j > ERA.last) ok = false; else t += v; } annual.push({ t, ok: ok && y * 12 + 11 <= LASTFULL }); }
  const amax = Math.max(1, ...annual.map(a => a.t));
  let g = `<svg viewBox="0 0 ${W} ${H}" role="grid" aria-label="Monthly burning calendar ${Y0} to ${Y0 + NYR - 1}. Rows are years, columns are months."><defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="${P.hatch}" stroke-width="1.3"/></pattern></defs>`;
  g += `<rect id="rowhl" class="rowhl" x="0" y="0" width="${W}" height="${ch + 2}" visibility="hidden"/>`;
  MON.forEach((mn, j) => g += `<text x="${LW + j * (cw + gap) + cw / 2}" y="9" text-anchor="middle">${mn.toUpperCase().slice(0, 1)}</text>`);
  g += `<text x="${W - RW + 6}" y="9">YEAR</text>`;
  for (let y = 0; y < NYR; y++) {
    const yy = top + y * (ch + gap), m0 = y * 12, src = srcOf(Math.min(m0 + 6, ERA.last));
    g += `<text x="${LW - 9}" y="${yy + ch - 2}" text-anchor="end" style="font-size:8.5px">${Y0 + y}</text><rect x="${LW - 5}" y="${yy}" width="2" height="${ch}" fill="${SENSCOL[src] || P.ink4}" opacity=".8"/>`;
    for (let j = 0; j < 12; j++) {
      const m = m0 + j, v = s.H[m], x = LW + j * (cw + gap);
      if (m > ERA.last) { g += `<rect x="${x + .5}" y="${yy + .5}" width="${cw - 1}" height="${ch - 1}" fill="none" stroke="${P.rule}" stroke-dasharray="2 2"/>`; continue; }
      const fill = state.view === 'anom' ? divColor(s.med[j] > 0 ? v / s.med[j] : (v > 0 ? 9 : 1)) : sc.color(v);
      g += `<rect class="cell" style="--r:${y};--c:${j}" data-m="${m}" x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="1" fill="${fill}" tabindex="${m === state.m ? 0 : -1}" role="gridcell" aria-label="${MONL[j]} ${Y0 + y}: ${isNaN(v) ? 'no data' : fmt(v) + ' hotspots'}"/>`;
      if (srcOf(m) === 1) g += `<rect x="${x}" y="${yy}" width="${cw}" height="${ch}" rx="1" fill="url(#hatch)" pointer-events="none"/>`;
      if (m === PARTIAL) g += `<rect x="${x + .5}" y="${yy + .5}" width="${cw - 1}" height="${ch - 1}" fill="none" stroke="${P.ink}" stroke-dasharray="2 2" pointer-events="none"/>`;
      if (s.rank[m] === 1 && s.nYears[j] >= 10 && v > 0 && s.med[j] > 0 && v / s.med[j] >= 1.25) g += `<circle cx="${x + cw - 4}" cy="${yy + 4}" r="2.2" fill="${P.recFill}" stroke="${P.recStroke}" stroke-width=".8" pointer-events="none"/>`;
    }
    const a = annual[y], bw = Math.max(1, (RW - 30) * a.t / amax);
    g += `<rect class="ytot" x="${W - RW + 6}" y="${yy + 3}" width="${bw}" height="${ch - 6}" fill="${a.ok ? P.ink3 : P.ink4}"/><text x="${W - RW + 10 + bw}" y="${yy + ch - 3}" style="font-size:8.5px">${a.t ? kfmt(a.t) : ''}</text>`;
  }
  const ty = top + (NYR + 0.6) * (ch + gap);
  g += `<text x="${LW - 9}" y="${ty + ch - 3}" text-anchor="end" style="fill:var(--ink)">TYP</text>`;
  for (let j = 0; j < 12; j++) { const x = LW + j * (cw + gap), v = s.med[j]; g += `<rect x="${x}" y="${ty}" width="${cw}" height="${ch}" rx="1" fill="${state.view === 'anom' ? P.div[3] : sc.color(v)}" stroke="${P.ink}" stroke-opacity=".5" stroke-width=".6"><title>Typical ${MONL[j]} (median ${Y0}–${BASE_Y1}): ${fmt(v)}</title></rect>`; }
  el.innerHTML = g + '</svg>';
  // legend
  let lg = '';
  if (state.view === 'anom') lg = DIV.map(d => `<span class="sw"><i style="background:${d.c}"></i>${d.l}</span>`).join('') + '<span>VS TYPICAL MONTH</span>';
  else lg = `<span class="ramp"><span class="bar" style="background:${GRAD}"></span><span class="ticks"><span>${fmt(sc.q(0))}</span><span>${kfmt(sc.q(.5))}</span><span>${kfmt(sc.q(1))}</span></span></span><span>HOTSPOTS / MONTH</span>`;
  lg += `<span class="sw"><i style="background:${STOPS[4]};background-image:repeating-linear-gradient(45deg,${P.hatch} 0 1.4px,transparent 1.4px 4px)"></i>MODIS EST.</span><span class="sw"><i style="background:${SENSCOL[1]};width:2px"></i><i style="background:${SENSCOL[2]};width:2px"></i><i style="background:${SENSCOL[3]};width:2px"></i>SENSOR</span><span class="sw"><i style="background:${P.recFill};border:1px solid ${P.recStroke === 'none' ? P.recFill : P.recStroke};width:6px;height:6px;border-radius:50%"></i>RECORD</span>`;
  $('#calLegend').innerHTML = lg;
  wireGrid(el.querySelector('svg'), ch, top, gap);
  const sel = $(`#calendar .cell[data-m="${state.m}"]`); if (sel) sel.classList.add('sel');
}
function wireGrid(svg, ch, top, gap) {
  const hl = svg.querySelector('#rowhl');
  svg.addEventListener('mousemove', e => { const t = e.target.closest('.cell'); if (t) { const m = +t.dataset.m; showTip(cellTip(m), e); hl.setAttribute('y', top + Math.floor(m / 12) * (ch + gap) - 1); hl.setAttribute('visibility', 'visible'); } else { hideTip(); hl.setAttribute('visibility', 'hidden'); } });
  svg.addEventListener('mouseleave', () => { hideTip(); hl.setAttribute('visibility', 'hidden'); });
  svg.addEventListener('click', e => { const t = e.target.closest('.cell'); if (t) { stop(); setMonth(+t.dataset.m); } });
  svg.addEventListener('keydown', e => {
    const t = e.target.closest('.cell'); if (!t) return; let m = +t.dataset.m; const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 }[e.key];
    if (mv) { e.preventDefault(); e.stopPropagation(); m = clamp(m + mv, 0, ERA.last); const n = svg.querySelector(`.cell[data-m="${m}"]`); if (n) { t.tabIndex = -1; n.tabIndex = 0; n.focus(); setMonth(m); const r = n.getBoundingClientRect(); showTip(cellTip(m), { clientX: r.right, clientY: r.bottom }); } }
    if (e.key === 'Escape') hideTip();
  });
}
function renderWeekly() {
  const el = $('#calendar'), W8 = state.weekly;
  if (!W8) { el.innerHTML = '<p class="note">Weekly data is not in this build.</p>'; return; }
  const PER = 53, W = Math.max(380, el.clientWidth || 430), LW = 40, cw = (W - LW) / PER, ch = 12, gap = 1.5, top = 16, H = top + NY * (ch + gap) + 4, lastW = META.weekly.lastWeek;
  const sc = makeScale(Array.from(W8).filter((v, k) => k <= lastW));
  const wmed = []; for (let k = 0; k < PER; k++) { const xs = []; for (let y = 0; Y0 + y <= BASE_Y1; y++) xs.push(W8[y * PER + k]); xs.sort((a, b) => a - b); wmed.push(xs[xs.length >> 1]); }
  let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly burning calendar: rows are years, columns are weeks."><defs><pattern id="hatchw" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="${P.hatch}" stroke-width="1"/></pattern></defs>`;
  MON.forEach((mn, j) => { const wk = Math.floor((Date.UTC(2001, j, 1) - Date.UTC(2001, 0, 1)) / 864e5 / 7); g += `<text x="${LW + wk * cw}" y="9">${mn.toUpperCase().slice(0, 1)}</text>`; });
  for (let y = 0; y < NY; y++) {
    const yy = top + y * (ch + gap); g += `<text x="${LW - 9}" y="${yy + ch - 3}" text-anchor="end">${Y0 + y}</text>`;
    for (let k = 0; k < PER; k++) { const idx = y * PER + k; if (idx > lastW) continue; const v = W8[idx]; const fill = state.view === 'anom' ? divColor(wmed[k] > 0 ? v / wmed[k] : (v > 0 ? 9 : 1)) : sc.color(v);
      g += `<rect class="wk" data-k="${idx}" x="${LW + k * cw}" y="${yy}" width="${Math.max(1, cw - 1)}" height="${ch}" fill="${fill}"/>`;
      if (META.weekly.modisBefore && idx < META.weekly.modisBefore) g += `<rect x="${LW + k * cw}" y="${yy}" width="${Math.max(1, cw - 1)}" height="${ch}" fill="url(#hatchw)" pointer-events="none"/>`; }
  }
  el.innerHTML = g + '</svg>';
  $('#calLegend').innerHTML = (state.view === 'anom' ? DIV.map(d => `<span class="sw"><i style="background:${d.c}"></i>${d.l}</span>`).join('') : `<span class="ramp"><span class="bar" style="background:${GRAD}"></span><span class="ticks"><span>${fmt(sc.q(0))}</span><span>${kfmt(sc.q(.5))}</span><span>${kfmt(sc.q(1))}</span></span></span><span>HOTSPOTS / WEEK · 1° CELLS</span>`) + '<span>ONE ROW PER YEAR, READ LIKE A CONTRIBUTION GRAPH</span>';
  const svg = el.querySelector('svg');
  svg.addEventListener('mousemove', e => { const t = e.target.closest('.wk'); if (!t) return hideTip(); const k = +t.dataset.k, y = Y0 + Math.floor(k / PER), w = k % PER, d0 = new Date(Date.UTC(y, 0, 1 + 7 * w)), d1 = new Date(Math.min(Date.UTC(y, 11, 31), Date.UTC(y, 0, 7 + 7 * w))); showTip(`<div class="tt"><i style="background:${t.getAttribute('fill')}"></i>${d0.getUTCDate()} ${MON[d0.getUTCMonth()]} – ${d1.getUTCDate()} ${MON[d1.getUTCMonth()]} ${y}</div><div class="tv"><b>${fmt(W8[k])}</b> HOTSPOTS · NOAA-20 UNITS<br>TYPICAL FOR THIS WEEK ${fmt(wmed[w])}</div>`, e); });
  svg.addEventListener('mouseleave', hideTip);
  svg.addEventListener('click', e => { const t = e.target.closest('.wk'); if (!t) return; const k = +t.dataset.k, y = Math.floor(k / PER), w = k % PER; const d = new Date(Date.UTC(Y0 + y, 0, 1 + 7 * w)); stop(); setMonth((d.getUTCFullYear() - Y0) * 12 + d.getUTCMonth()); });
}
function renderTable() {
  const s = state.series; let h = '<table><caption>Monthly hotspots in NOAA-20 VIIRS units (e = estimated from MODIS)</caption><thead><tr><th scope="col">YEAR</th>' + MON.map(m => `<th scope="col">${m.toUpperCase()}</th>`).join('') + '<th scope="col">TOTAL</th></tr></thead><tbody>';
  for (let y = 0; y < NY; y++) { let t = 0; h += `<tr><th scope="row">${Y0 + y}</th>`; for (let j = 0; j < 12; j++) { const m = y * 12 + j, v = s.H[m]; if (!isNaN(v) && m <= ERA.last) t += v; h += `<td>${m > ERA.last || isNaN(v) ? '' : fmt(v)}${srcOf(m) === 1 && m <= ERA.last ? 'e' : ''}</td>`; } h += `<td>${fmt(t)}</td></tr>`; }
  $('#tableWrap').innerHTML = h + `<tr><th scope="row">TYP</th>${s.med.map(v => `<td>${fmt(v)}</td>`).join('')}<td></td></tr></tbody></table>`;
}
function renderMapRamp() { const sc = state.cellScale; $('#mapRamp').innerHTML = `<span>HOTSPOTS PER CELL · MONTH</span><span class="bar" style="background:${GRAD}"></span><span class="ticks"><span>1</span><span>${kfmt(sc.q(.5))}</span><span>${kfmt(sc.q(.98))}+</span></span>`; }

// ---------------- timeline ----------------
const TL = { W: 1000, H: 124, L: 12, R: 12, top: 26, base: 80 };
const tx = m => TL.L + (TL.W - TL.L - TL.R) * m / ERA.last;
function buildTimeline() {
  const s = state.series, svg = $('#tlSvg'), box = $('#tlMain').getBoundingClientRect(); TL.W = Math.max(500, box.width - 16); TL.H = Math.max(100, box.height);
  TL.top = 26; TL.base = TL.H - 44;
  svg.setAttribute('viewBox', `0 0 ${TL.W} ${TL.H}`); svg.setAttribute('aria-valuemax', ERA.last);
  const vmax = Math.max(1, ...Array.from(s.H).filter((v, m) => m <= ERA.last && !isNaN(v)));
  const hY = v => TL.base - (TL.base - TL.top) * Math.sqrt(Math.max(0, v) / vmax);
  const bw = Math.max(1, (TL.W - TL.L - TL.R) / (ERA.last + 1) - 0.6);
  let g = `<defs><pattern id="hatchT" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="3" stroke="${P.hatch}" stroke-width="1"/></pattern></defs>`;
  const eras = [[0, ERA.snppStart - 1, 'TERRA + AQUA MODIS · ESTIMATED', SENSCOL[1]], [ERA.snppStart, ERA.n20Start - 1, 'S-NPP VIIRS · CROSS-CAL.', SENSCOL[2]], [ERA.n20Start, ERA.last, 'NOAA-20 VIIRS · OBSERVED', SENSCOL[3]]];
  const SHORT = ['MODIS · EST.', 'S-NPP · CAL.', 'NOAA-20 · OBS.']; eras.forEach(([a, b, lab], i) => { const room = tx(i < 2 ? eras[i + 1][0] : ERA.last) - tx(a) - 12; const t = lab.length * 7.4 < room ? lab : SHORT[i]; g += `<text class="era" x="${tx(a) + 2}" y="13">${t}</text>`; });
  for (let y = 0; y <= NY; y++) { const m = y * 12; if (m > ERA.last) break; g += `<line x1="${tx(m)}" x2="${tx(m)}" y1="${TL.base}" y2="${TL.base + (y % 5 === 0 ? 6 : 3)}" stroke="${P.ink4}"/>`; if (y % 5 === 0) g += `<text x="${tx(m)}" y="${TL.H - 6}" text-anchor="middle">${Y0 + y}</text>`; }
  g += `<g id="tlBars">`;
  for (let m = 0; m <= ERA.last; m++) { const v = s.H[m]; if (isNaN(v)) continue; const y0 = hY(v), src = srcOf(m); const col = P.bars[src] || P.bars[1];
    g += `<rect class="tb" data-m="${m}" x="${tx(m) - bw / 2}" y="${y0}" width="${bw}" height="${Math.max(0.5, TL.base - y0)}" fill="${col}"/>`;
    if (src === 1) g += `<rect x="${tx(m) - bw / 2}" y="${y0}" width="${bw}" height="${Math.max(0.5, TL.base - y0)}" fill="url(#hatchT)" pointer-events="none"/>`; }
  g += `</g>`;
  // naive stitch overlay (raw counts as they come from each sensor)
  const modisAvg = m => { const k = AV[0][m] + AV[1][m]; return k ? (s.T[m] + s.A[m]) / k : NaN; };
  let d = '', pen = false; for (let m = 0; m <= ERA.last; m++) { const v = m >= ERA.n20Start ? s.N2[m] : m >= ERA.snppStart ? s.SN[m] : modisAvg(m); if (isNaN(v)) { pen = false; continue; } d += (pen ? 'L' : 'M') + tx(m).toFixed(1) + ' ' + hY(v).toFixed(1); pen = true; }
  g += `<path id="tlCmp" d="${d}" fill="none" stroke="${P.cold}" stroke-width="1.3" visibility="${state.cmp ? 'visible' : 'hidden'}"/>`;
  // relay track
  const ry = TL.base + 14;
  for (const [a, b, , col] of eras) g += `<line x1="${tx(a)}" x2="${tx(b)}" y1="${ry}" y2="${ry}" stroke="${col}" stroke-width="3"/>`;
  for (const m of [ERA.snppStart, ERA.n20Start]) { const [y, mo] = ym(m); g += `<rect x="${tx(m) - 4}" y="${ry - 4}" width="8" height="8" transform="rotate(45 ${tx(m)} ${ry})" fill="${P.bg}" stroke="${P.ink}"/><text class="ho" x="${tx(m) + 8}" y="${ry - 6}" style="fill:var(--ink2);font-size:8.5px">HANDOVER ${String(mo + 1).padStart(2, '0')}·${y}</text>`; }
  g += `<line x1="${TL.L}" x2="${TL.W - TL.R}" y1="${TL.base}" y2="${TL.base}" stroke="${P.line}"/>`;
  g += `<g id="tlHead" class="tl-head"><line x1="0" x2="0" y1="${TL.top - 6}" y2="${TL.base + 20}" stroke="${P.amber}" stroke-width="1.2"/><path d="M-5 ${TL.top - 12} h10 v6 l-5 5 l-5 -5z" fill="${P.amber}"/></g>`;
  g += `<rect id="tlHit" x="0" y="0" width="${TL.W}" height="${TL.H}" fill="transparent"/>`;
  svg.innerHTML = g;
  TL.bars = [...svg.querySelectorAll('#tlBars .tb')];
  updateTimeline();
}
function updateTimeline() {
  const s = state.series; if (!s || !TL.bars) return; const m = state.m, [y, mo] = ym(m), v = s.H[m], md = s.med[mo];
  $('#tlHead').setAttribute('transform', `translate(${tx(m)},0)`);
  for (const b of TL.bars) b.classList.toggle('future', state.playing && +b.dataset.m > m);
  $('#tlDate').innerHTML = `${MON[mo]} ${y}<small>${m === PARTIAL ? 'SO FAR' : ''}</small>`;
  $('#tlVal').innerHTML = `${fmt(v)} HOTSPOTS · <span class="${md > 0 && v / md >= 1.25 ? 'hot' : ''}">${md > 0 ? xfmt(v / md) + '× TYPICAL' : '–'}</span>`;
  $('#tlSvg').setAttribute('aria-valuenow', m); $('#tlSvg').setAttribute('aria-valuetext', `${MONL[mo]} ${y}`);
}
function tlMonthAt(ev) { const svg = $('#tlSvg'), r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * TL.W / r.width; return clamp(Math.round((px - TL.L) / (TL.W - TL.L - TL.R) * ERA.last), 0, ERA.last); }
let dragging = false;
$('#tlSvg').addEventListener('pointerdown', e => { dragging = true; stop(); $('#tlSvg').setPointerCapture(e.pointerId); setMonth(tlMonthAt(e)); });
$('#tlSvg').addEventListener('pointermove', e => { if (dragging) setMonth(tlMonthAt(e)); else { const m = tlMonthAt(e); showTip(cellTip(m), e); } });
$('#tlSvg').addEventListener('pointerup', () => { dragging = false; });
$('#tlSvg').addEventListener('pointerleave', hideTip);
$('#tlSvg').addEventListener('keydown', e => { const mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 12, ArrowDown: -12, Home: -1e4, End: 1e4 }[e.key]; if (mv) { e.preventDefault(); stop(); setMonth(state.m + mv); } });

// ---------------- playback ----------------
let raf = 0, last = 0;
function play(endAt = ERA.last) {
  if (!state.series) return; if (state.m >= endAt) setMonth(0); state.endAt = endAt;
  state.playing = true; $('#play').classList.add('on'); $('#playIcon').setAttribute('d', 'M4 2.5h3v11H4zM9 2.5h3v11H9z'); $('#play').setAttribute('aria-label', 'Pause');
  last = performance.now(); const tick = now => { if (!state.playing) return; if (now - last >= 1000 / state.speed) { last = now; if (state.m >= state.endAt) { stop(); return; } setMonth(state.m + 1); } raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick);
}
function stop() { if (!state.playing) return; state.playing = false; cancelAnimationFrame(raf); $('#play').classList.remove('on'); $('#playIcon').setAttribute('d', 'M4 2.5v11l9-5.5z'); $('#play').setAttribute('aria-label', 'Play the record month by month'); updateTimeline(); renderNarration(); }
$('#play').onclick = () => state.playing ? stop() : play();
let introOn = false;
async function intro() {
  const sp = state.speed; introOn = true; state.speed = 30; setMonth(0, { force: true });
  const cancel = () => { if (introOn) { introOn = false; stop(); state.speed = sp; } };
  ['pointerdown', 'keydown', 'wheel'].forEach(ev => window.addEventListener(ev, cancel, { once: true, capture: true }));
  await new Promise(r => setTimeout(r, 700)); if (!introOn) return;
  play(LASTFULL); const iv = setInterval(() => { if (!state.playing) { introOn = false; state.speed = sp; clearInterval(iv); } }, 200);
}
$$('.speed button').forEach(b => b.onclick = () => { state.speed = +b.dataset.sp; $$('.speed button').forEach(x => x.setAttribute('aria-checked', String(x === b))); });
$('#cmpBtn').onclick = () => { state.cmp = !state.cmp; $('#cmpBtn').setAttribute('aria-pressed', String(state.cmp)); const p = $('#tlCmp'); if (p) p.setAttribute('visibility', state.cmp ? 'visible' : 'hidden'); };
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, [contenteditable]')) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stop() : play(); }
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.target.closest('svg')) { e.preventDefault(); stop(); setMonth(state.m + (e.key === 'ArrowRight' ? 1 : -1)); }
});

// ---------------- downloads & links ----------------
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const slug = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
$('#dlCsv').onclick = () => {
  const s = state.series, a = state.aoi; if (!s) return;
  const rows = [`# FireRelay harmonized burning calendar · ${a.name}`, `# Units: active-fire hotspots in NOAA-20 VIIRS 375 m equivalent (nominal+high confidence, presumed vegetation fires, FIRMS type 0)`, `# Source data: NASA FIRMS standard archive (MODIS C6.1, VIIRS S-NPP/NOAA-20 375 m) + near-real-time for the latest months; built ${META.built.slice(0, 10)}; data through ${META.lastDate || ''}`, `# lower80/upper80: 80% uncertainty from hold-out validation (MODIS era) or S-NPP to NOAA-20 cross-calibration; 0.25 deg cells weighted by fraction inside area`, `# Method and validation: https://firerelay.vercel.app/method.html`,
    'year,month,hotspots_harmonized,lower80,upper80,source,partial_month,raw_terra_modis,raw_aqua_modis,raw_snpp_viirs,raw_noaa20_viirs,typical_median,ratio_to_typical,rank_among_same_month,years_ranked'];
  for (let m = 0; m <= ERA.last; m++) { const [y, j] = ym(m), v = s.H[m]; if (isNaN(v)) continue; const [lo, hi] = band(m, v); rows.push([y, j + 1, v.toFixed(1), lo.toFixed(1), hi.toFixed(1), ['', 'modis_estimate', 'snpp_crosscal', 'noaa20_observed'][srcOf(m)], m === PARTIAL ? 1 : 0, s.T[m].toFixed(1), s.A[m].toFixed(1), AV[2][m] ? s.SN[m].toFixed(1) : '', AV[3][m] ? s.N2[m].toFixed(1) : '', s.med[j].toFixed(1), s.med[j] > 0 ? (v / s.med[j]).toFixed(3) : '', s.rank[m] ?? '', s.nYears[j]].join(',')); }
  download(`firerelay_${slug(a.name)}_monthly.csv`, rows.join('\n'), 'text/csv');
};
$('#dlGeo').onclick = () => { const a = state.aoi; if (a) download(`firerelay_${slug(a.name)}_area.geojson`, JSON.stringify({ type: 'Feature', properties: { name: a.name }, geometry: a.geometry }), 'application/geo+json'); };
$('#share').onclick = async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); $('#share').textContent = '✓ COPIED'; } catch { prompt('Copy this link', location.href); } setTimeout(() => $('#share').textContent = '↗ LINK', 1500); };
function writeHash() {
  const a = state.aoi; if (!a) return; let h = '';
  if (a.kind === 'preset') h = 'p=' + a.id; else if (a.kind === 'circle') h = `c=${a.lat.toFixed(3)},${a.lon.toFixed(3)},${a.km}`; else if (a.kind === 'box') h = 'b=' + a.box.map(v => v.toFixed(3)).join(','); else h = 'g=' + a.geometry.coordinates[0].map(([x, y]) => x.toFixed(3) + ',' + y.toFixed(3)).join(';');
  h += `&v=${state.view}&s=${state.step}`; history.replaceState(null, '', '#' + h);
}
const presetAOI = p => ({ kind: 'preset', id: p.id, name: p.name, note: p.note, geometry: p.geometry });
const circleAOI = (lat, lon, km) => ({ kind: 'circle', id: 'circle', lat, lon, km, name: `${km} km around ${lat.toFixed(2)}, ${lon.toFixed(2)}`, geometry: circlePoly(lat, lon, km) });
const boxAOI = (w, s, e, n) => ({ kind: 'box', id: 'box', box: [w, s, e, n], name: `Box ${w.toFixed(1)}, ${s.toFixed(1)} to ${e.toFixed(1)}, ${n.toFixed(1)}`, geometry: boxPoly(w, s, e, n) });
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1)); if (q.get('v')) setSeg('view', q.get('v')); if (q.get('s')) setSeg('step', q.get('s'));
  if (q.get('p')) { const p = PRESETS.find(x => x.id === q.get('p')); if (p) return presetAOI(p); }
  if (q.get('c')) { const [lat, lon, km] = q.get('c').split(',').map(Number); return circleAOI(lat, lon, km); }
  if (q.get('b')) { const [w, s, e, n] = q.get('b').split(',').map(Number); return boxAOI(w, s, e, n); }
  if (q.get('g')) { const ring = q.get('g').split(';').map(p => p.split(',').map(Number)); return { kind: 'poly', id: 'custom', name: 'Custom area', geometry: { type: 'Polygon', coordinates: [ring] } }; }
  return null;
}

// ---------------- UI wiring ----------------
function setSeg(kind, val) { state[kind] = val; $$(`.seg button[data-${kind}]`).forEach(b => b.setAttribute('aria-checked', String(b.dataset[kind] === val))); }
$$('.seg button[data-view]').forEach(b => b.onclick = () => { setSeg('view', b.dataset.view); if (state.series) { renderCalendar(); writeHash(); } });
$$('.seg button[data-step]').forEach(b => b.onclick = () => { setSeg('step', b.dataset.step); if (state.series) { renderCalendar(); writeHash(); } });
$('#tableBtn').onclick = () => { const w = $('#tableWrap'); w.hidden = !w.hidden; $('#tableBtn').setAttribute('aria-expanded', String(!w.hidden)); if (!w.hidden) renderTable(); };
$$('.tabs button').forEach(b => b.onclick = () => { $$('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b))); $$('.tabpanel').forEach(p => p.hidden = p.id !== 'tab-' + b.dataset.tab); });
const groups = [...new Set(PRESETS.map(p => p.group))]; let gi = 0;
$('#presetList').innerHTML = groups.map(g => `<h3>${esc(g.replace('(', '· ').replace(')', ''))}</h3>` + PRESETS.map((p, i) => [p, i]).filter(([p]) => p.group === g).map(([p, i]) => `<button class="file" style="--i:${gi++}" data-preset="${p.id}" aria-pressed="false" title="${esc(p.note)}"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="t">${esc(p.name)}</span></button>`).join('')).join('');
document.addEventListener('click', e => { const b = e.target.closest('[data-preset]'); if (b) { const p = PRESETS.find(x => x.id === b.dataset.preset); if (p) setAOI(presetAOI(p)); } });
$('#pointForm').onsubmit = e => { e.preventDefault(); setAOI(circleAOI(+$('#inLat').value, +$('#inLon').value, +$('#inRad').value)); };
$('#boxForm').onsubmit = e => { e.preventDefault(); const w = +$('#inW').value, s = +$('#inS').value, ee = +$('#inE').value, n = +$('#inN').value; if (ee <= w || n <= s) return alert('East must be greater than West, and North greater than South.'); setAOI(boxAOI(w, s, ee, n)); };
let mode = null, start = null, temp = null, pts = [];
function endDraw() { mode = null; map.dragging.enable(); map.doubleClickZoom.enable(); map.getContainer().classList.remove('fb-draw'); $('#drawRect').classList.remove('active'); $('#drawPoly').classList.remove('active'); }
$('#drawRect').onclick = () => { endDraw(); mode = 'rect'; map.dragging.disable(); map.getContainer().classList.add('fb-draw'); $('#drawRect').classList.add('active'); $('#drawHint').textContent = 'Press and drag on the map.'; };
$('#drawPoly').onclick = () => { endDraw(); mode = 'poly'; pts = []; map.doubleClickZoom.disable(); map.getContainer().classList.add('fb-draw'); $('#drawPoly').classList.add('active'); $('#drawHint').textContent = 'Click each corner; double-click to finish.'; };
$('#drawClear').onclick = () => { endDraw(); drawLayer.clearLayers(); };
const DRAWSTYLE = { color: P.amber, weight: 1.4, fillOpacity: 0.06, dashArray: '3 4' };
map.on('mousedown', e => { if (mode !== 'rect') return; start = e.latlng; temp = L.rectangle([start, start], DRAWSTYLE).addTo(drawLayer); });
map.on('mousemove', e => { if (mode === 'rect' && start && temp) temp.setBounds([start, e.latlng]); if (mode === 'poly' && pts.length && temp) temp.setLatLngs([...pts, e.latlng]); });
map.on('mouseup', e => { if (mode !== 'rect' || !start) return; const b = L.latLngBounds(start, e.latlng); start = null; endDraw(); if (Math.abs(b.getEast() - b.getWest()) < 0.2 || Math.abs(b.getNorth() - b.getSouth()) < 0.2) { drawLayer.clearLayers(); $('#drawHint').textContent = 'Too small: draw at least about 25 km across.'; return; } setAOI({ ...boxAOI(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()), name: 'Drawn rectangle' }); });
map.on('click', e => { if (mode !== 'poly') return; pts.push(e.latlng); if (!temp) temp = L.polyline(pts, DRAWSTYLE).addTo(drawLayer); else temp.setLatLngs(pts); });
map.on('dblclick', () => { if (mode !== 'poly') return; endDraw(); if (pts.length < 3) return; const ring = pts.map(p => [p.lng, p.lat]); ring.push(ring[0]); temp = null; setAOI({ kind: 'poly', id: 'custom', name: 'Drawn polygon', geometry: { type: 'Polygon', coordinates: [ring] } }); pts = []; });

let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { map.invalidateSize(); if (state.series) { renderCalendar(); buildTimeline(); } }, 150); });
window.addEventListener('hashchange', () => { const a = readHash(); if (a && (!state.aoi || JSON.stringify(a.geometry) !== JSON.stringify(state.aoi.geometry))) setAOI(a, { push: false }); else if (state.series) renderCalendar(); });
setTimeout(() => map.invalidateSize(), 50);
const fromHash = readHash();
setAOI(fromHash || presetAOI(PRESETS.find(p => p.id === 'central-kalimantan') || PRESETS[0]), { push: !!fromHash }).then(() => { if (!fromHash && !/nointro/.test(location.search)) setTimeout(intro, 1400); });
function syncThemeBtn() { const t = theme(); $('#themeLbl').textContent = t === 'dark' ? 'LIGHT' : 'DARK'; document.querySelector('meta[name=theme-color]').setAttribute('content', t === 'dark' ? '#0b0b0a' : '#f4f2ec'); }
syncThemeBtn();
$('#themeBtn').onclick = () => {
  const t = theme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; localStorage.setItem('fr-theme', t); applyPalette(); syncThemeBtn();
  aoiLayer.eachLayer(l => l.setStyle && l.setStyle({ color: P.aoi }));
  if (state.series) { renderCalendar(); buildTimeline(); renderMapRamp(); setMonth(state.m, { force: true }); if (!$('#tableWrap').hidden) renderTable(); }
};
window.__fr = { state, setMonth, play, stop };
