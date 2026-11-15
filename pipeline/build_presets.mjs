// FireRelay: build preset areas of interest from geoBoundaries (simplified ADM0/ADM1 polygons).
// Output: web/data/geo/presets.json  [{id, group, name, note, source, license, geometry}]
import fs from 'node:fs';

const OUT = process.argv[2];
const api = (iso, adm) => `https://www.geoboundaries.org/api/current/gbOpen/${iso}/${adm}/`;
const cache = new Map();
async function layer(iso, adm) {
  const k = iso + adm; if (cache.has(k)) return cache.get(k);
  const meta = await (await fetch(api(iso, adm))).json();
  const gj = await (await fetch(meta.simplifiedGeometryGeoJSON)).json();
  const v = { meta, gj }; cache.set(k, v); return v;
}
// Douglas-Peucker on a ring (lon/lat degrees)
function dp(pts, eps) {
  if (pts.length < 5) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    const [x1, y1] = pts[a], [x2, y2] = pts[b]; const dx = x2 - x1, dy = y2 - y1; const L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) { const d = L < 1e-9 ? Math.hypot(pts[i][0] - x1, pts[i][1] - y1) : Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / L; if (d > md) { md = d; mi = i; } }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}
function simplifyGeom(g, eps) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out = [];
  for (const p of polys) {
    const rings = p.map(r => dp(r, eps)).filter(r => r.length >= 4);
    // drop tiny islands (outer ring bbox < ~0.05 deg)
    if (!rings.length) continue;
    const xs = rings[0].map(c => c[0]), ys = rings[0].map(c => c[1]);
    if (Math.max(...xs) - Math.min(...xs) < 0.05 && Math.max(...ys) - Math.min(...ys) < 0.05) continue;
    out.push(rings);
  }
  return { type: 'MultiPolygon', coordinates: out };
}
function merge(geoms) { return { type: 'MultiPolygon', coordinates: geoms.flatMap(g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates) }; }
const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const presets = [];
async function add({ id, group, name, note, iso, adm = 'ADM1', match, exclude, eps = 0.02 }) {
  const { meta, gj } = await layer(iso, adm);
  let feats = gj.features;
  if (match) feats = feats.filter(f => match.some(m => norm(f.properties.shapeName).includes(norm(m))));
  if (exclude) feats = feats.filter(f => !exclude.some(m => norm(f.properties.shapeName).includes(norm(m))));
  if (!feats.length) { console.error('NO MATCH', id, gj.features.map(f => f.properties.shapeName).join(' | ')); return; }
  const geom = simplifyGeom(merge(feats.map(f => f.geometry)), eps);
  presets.push({ id, group, name, note, source: `geoBoundaries gbOpen ${meta.boundaryID}`, license: meta.boundaryLicense, geometry: geom });
  console.log('ok', id, feats.map(f => f.properties.shapeName).join(', '));
}

const SEA = 'Singapore haze watch (Southeast Asia)';
await add({ id: 'riau', group: SEA, name: 'Riau, Sumatra', note: 'Peatland province upwind of Singapore during the Aug to Oct haze season.', iso: 'IDN', match: ["Riau"], exclude: ["Kepulauan", "Islands"] });
await add({ id: 'jambi', group: SEA, name: 'Jambi, Sumatra', note: 'Peat and plantation fires; a recurrent haze source.', iso: 'IDN', match: ['Jambi'] });
await add({ id: 'south-sumatra', group: SEA, name: 'South Sumatra', note: 'Largest Sumatran source in the 2015 and 2019 haze crises.', iso: 'IDN', match: ['Sumatera Selatan', 'South Sumatra'] });
await add({ id: 'west-kalimantan', group: SEA, name: 'West Kalimantan, Borneo', note: 'Smoke drifts to Sarawak, Singapore and the Philippines.', iso: 'IDN', match: ['Kalimantan Barat', 'West Kalimantan'] });
await add({ id: 'central-kalimantan', group: SEA, name: 'Central Kalimantan, Borneo', note: 'Deep peat domes; the 2015 fire epicentre.', iso: 'IDN', match: ['Kalimantan Tengah', 'Central Kalimantan'] });
await add({ id: 'peninsular-malaysia', group: SEA, name: 'Peninsular Malaysia', note: 'Closest land neighbour of Singapore.', iso: 'MYS', exclude: ['Sabah', 'Sarawak', 'Labuan'] });
await add({ id: 'indonesia', group: SEA, name: 'Indonesia (whole country)', note: 'National total.', iso: 'IDN', adm: 'ADM0', eps: 0.05 });
const ARG = 'Argentina (CONAE region)';
await add({ id: 'cordoba', group: ARG, name: 'Córdoba', note: 'Recurrent winter-spring wildfires in the Sierras.', iso: 'ARG', match: ['Cordoba'] });
await add({ id: 'corrientes', group: ARG, name: 'Corrientes', note: 'Iberá wetlands, record fires in early 2022.', iso: 'ARG', match: ['Corrientes'] });
const W = 'Elsewhere';
await add({ id: 'para', group: W, name: 'Pará, Brazil (Amazon)', note: 'Deforestation-linked burning.', iso: 'BRA', match: ['Para'], exclude: ['Parana', 'Paraiba'] });
await add({ id: 'nsw', group: W, name: 'New South Wales, Australia', note: 'Black Summer 2019 to 2020.', iso: 'AUS', match: ['New South Wales'] });
await add({ id: 'california', group: W, name: 'California, USA', note: 'Western US wildfire season.', iso: 'USA', match: ['California'] });

fs.mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(presets));
console.log('wrote', presets.length, 'presets', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
