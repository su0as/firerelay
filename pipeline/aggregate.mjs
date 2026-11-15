// FireRelay pipeline step 1: stream FIRMS archive CSV rows (stdin) into gridded counts.
// Usage: unzip -p modis_2019_all_countries.zip | node aggregate.mjs <family: modis|viirs-snpp|viirs-jpss1|viirs-jpss2> <year> <outDir>
// Output per series-year (sparse, little-endian):
//   m_<series>_<year>.bin : repeated [uint32 cell025, uint8 month(0-11), uint32 count]   (0.25 deg grid, 1440 x 720)
//   w_<series>_<year>.bin : repeated [uint16 cell1,  uint8 week(0-52),  uint32 count]   (1 deg grid, 360 x 180)
// Filters (applied identically to every sensor):
//   type == 0 (presumed vegetation fire; drops volcanoes, static industrial sources, offshore)
//   MODIS confidence >= 30 (nominal + high); VIIRS confidence in {n, h} (nominal + high)
import fs from 'node:fs';
import path from 'node:path';

const [family, yearStr, outDir] = process.argv.slice(2);
const year = parseInt(yearStr, 10);
const SERIES = { Terra: 'terra', Aqua: 'aqua', N: 'snpp', N20: 'noaa20', N21: 'noaa21', '1': 'noaa20', '2': 'noaa21' };
const NC = 1440 * 720, NW = 360 * 180;
const monthly = new Map(); // series -> Uint32Array(NC*12)
const weekly = new Map();  // series -> Uint32Array(NW*53)
const stats = { rows: 0, kept: 0, dropType: 0, dropConf: 0, dropYear: 0, satellites: {} };
const isModis = family === 'modis';
const EMIT_NONVEG = process.env.EMIT_NONVEG === '1';
let idx = null; // column index map from header

function arr(map, key, n) { let a = map.get(key); if (!a) { a = new Uint32Array(n); map.set(key, a); } return a; }
const doyCache = new Map();
function dayOfYear(y, mo, d) { const k = mo * 100 + d; let v = doyCache.get(k); if (v === undefined) { v = Math.floor((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / 86400000); doyCache.set(k, v); } return v; }

function handle(line) {
  if (line.length < 10) return;
  if (line.charCodeAt(0) === 108 /* l */ && line.startsWith('latitude')) {
    const h = line.split(',');
    idx = { ncol: h.length, lat: h.indexOf('latitude'), lon: h.indexOf('longitude'), date: h.indexOf('acq_date'), sat: h.indexOf('satellite'), conf: h.indexOf('confidence'), type: h.indexOf('type') };
    return;
  }
  const f = line.split(","); if (!idx || f.length < idx.ncol) return;
  stats.rows++;
  const sat = f[idx.sat];
  stats.satellites[sat] = (stats.satellites[sat] || 0) + 1;
  const c = f[idx.conf];
  if (isModis) { if (parseInt(c, 10) < 30) { stats.dropConf++; return; } }
  else { const cc = c.trim(); if (cc === 'l' || cc === 'low') { stats.dropConf++; return; } }
  // NRT files carry no 'type' column: count them under <series>_notype; the build removes static sources per cell.
  let suffix = idx.type < 0 ? '_notype' : '';
  if (idx.type >= 0) { const t = f[idx.type].trim(); if (t !== '0') { stats.dropType++; if (!EMIT_NONVEG) return; suffix = '_nonveg'; } }
  const d = f[idx.date];
  const y = +d.slice(0, 4), mo = +d.slice(5, 7), dd = +d.slice(8, 10);
  if (y !== year) { stats.dropYear++; return; }
  const lat = +f[idx.lat], lon = +f[idx.lon];
  let r = Math.floor((lat + 90) / 0.25), cI = Math.floor((lon + 180) / 0.25);
  if (r < 0) r = 0; if (r > 719) r = 719; if (cI < 0) cI = 0; if (cI > 1439) cI = 1439;
  let r1 = Math.floor(lat + 90), c1 = Math.floor(lon + 180);
  if (r1 < 0) r1 = 0; if (r1 > 179) r1 = 179; if (c1 < 0) c1 = 0; if (c1 > 359) c1 = 359;
  const s = (SERIES[sat] || ('other_' + sat)) + suffix;
  arr(monthly, s, NC * 12)[(r * 1440 + cI) * 12 + (mo - 1)]++;
  const wk = Math.min(52, Math.floor(dayOfYear(y, mo, dd) / 7));
  arr(weekly, s, NW * 53)[(r1 * 360 + c1) * 53 + wk]++;
  stats.kept++;
}

let rest = '';
process.stdin.setEncoding('latin1');
process.stdin.on('data', (chunk) => {
  const s = rest + chunk;
  let start = 0, nl;
  while ((nl = s.indexOf('\n', start)) !== -1) { let line = s.slice(start, nl); if (line.endsWith('\r')) line = line.slice(0, -1); handle(line); start = nl + 1; }
  rest = s.slice(start);
});
process.stdin.on('end', () => {
  if (rest) handle(rest);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [s, a] of monthly) {
    let n = 0; for (let i = 0; i < a.length; i++) if (a[i]) n++;
    const buf = Buffer.alloc(n * 9); let o = 0;
    for (let i = 0; i < a.length; i++) if (a[i]) { buf.writeUInt32LE(Math.floor(i / 12), o); buf.writeUInt8(i % 12, o + 4); buf.writeUInt32LE(a[i], o + 5); o += 9; }
    fs.writeFileSync(path.join(outDir, `m_${s}_${year}.bin`), buf);
  }
  for (const [s, a] of weekly) {
    let n = 0; for (let i = 0; i < a.length; i++) if (a[i]) n++;
    const buf = Buffer.alloc(n * 7); let o = 0;
    for (let i = 0; i < a.length; i++) if (a[i]) { buf.writeUInt16LE(Math.floor(i / 53), o); buf.writeUInt8(i % 53, o + 2); buf.writeUInt32LE(a[i], o + 3); o += 7; }
    fs.writeFileSync(path.join(outDir, `w_${s}_${year}.bin`), buf);
  }
  fs.writeFileSync(path.join(outDir, `stats_${family}_${year}.json`), JSON.stringify(stats));
  console.log(family, year, JSON.stringify(stats));
});
