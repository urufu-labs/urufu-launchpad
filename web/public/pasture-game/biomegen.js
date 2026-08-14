// WOLVES & WOOL — procedural meadow generator (shared module).
// Kitbash world: Blender-authored kit pieces (kit.glb) scattered by a JS generator
// over endless noise terrain, streamed in chunks, with ANALYTIC collision (sample
// the noise directly — no baked heightfield). Biomes are laid along world +x and
// blend into each other, so walking east crosses Home Meadow → Pastures → Orchard.
//
// Used by the game (afterglow.html, ?world=proc). The proving sandbox procgen.html
// predates this module and keeps its own inlined copy.
import * as THREE from 'three';

// ---------------------------------------------------------------- deterministic noise
function hash01(ix, iy) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) >>> 0;
  n = (Math.imul(n ^ (n >>> 13), 1274126177)) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash01(x0, y0), b = hash01(x0 + 1, y0), c = hash01(x0, y0 + 1), d = hash01(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
function fbm(x, y, oct = 4) {
  let v = 0, amp = 1, f = 1, t = 0;
  for (let i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f); t += amp; amp *= 0.5; f *= 2; }
  return v / t;                                        // 0..1
}
const FREQ = 0.045, FREQ2 = 0.02;                      // shared across biomes → seamless height blend

// ---------------------------------------------------------------- biome presets
// terrain: amp/amp2/base/detail/water · palette: grass/grassHi/rock/sand ·
// scatter: [piece, weight] · atmo: sky/fog/hemiSky/hemiI/hemiGround/sun/sunI
const BIOMES = {
  shallows: {
    amp: 2.8, amp2: 1.5, base: 0.9, detail: 0.5, water: -40,
    scatterDensity: 0.75,
    grass: [0.34, 0.62, 0.25], grassHi: [0.56, 0.73, 0.34], rock: [0.43, 0.36, 0.25], sand: [0.72, 0.65, 0.43],
    scatter: [['pine', 0.23], ['pine_dark', 0.05], ['rock_s', 0.10], ['rock_l', 0.03], ['reed', 0.10], ['stump', 0.07], ['mushroom', 0.02]],
    atmo: { sky: 0xaed6f2, fog: 0.009, hemiSky: 0xffefce, hemiI: 1.0, hemiGround: 0x40532a, sun: 0xfff0c4, sunI: 2.8, spark: 0xffe1a2 },
  },
  ruins: {
    amp: 1.5, amp2: 1.1, base: 0.4, detail: 0.35, water: -40,
    scatterDensity: 0.70,
    grass: [0.43, 0.47, 0.22], grassHi: [0.63, 0.62, 0.31], rock: [0.42, 0.36, 0.25], sand: [0.70, 0.56, 0.29],
    scatter: [['pine', 0.17], ['pine_dark', 0.08], ['rock_s', 0.14], ['rock_l', 0.07], ['stump', 0.12], ['reed', 0.06], ['mushroom', 0.03]],
    atmo: { sky: 0xefd09a, fog: 0.014, hemiSky: 0xffdc9c, hemiI: 1.0, hemiGround: 0x4f3c1d, sun: 0xffb760, sunI: 2.2, spark: 0xffc36d },
  },
  drift: {
    amp: 3.6, amp2: 2.1, base: 0.6, detail: 0.6, water: -40,
    scatterDensity: 0.80,
    grass: [0.27, 0.38, 0.18], grassHi: [0.47, 0.56, 0.27], rock: [0.30, 0.25, 0.18], sand: [0.54, 0.43, 0.23],
    scatter: [['pine', 0.13], ['pine_dark', 0.16], ['mushroom', 0.06], ['rock_l', 0.08], ['rock_s', 0.10], ['stump', 0.15], ['reed', 0.05]],
    atmo: { sky: 0x6f8293, fog: 0.016, hemiSky: 0xb0c6b7, hemiI: 0.9, hemiGround: 0x243223, sun: 0xffd38a, sunI: 1.35, spark: 0xffd27a },
  },
};
// normalise atmo colours to THREE.Color up front, so a PURE biome (returned as the raw
// preset) hands back Colors — not hex numbers — to hemi.color.copy()/scene.background.
for (const k in BIOMES) {
  const a = BIOMES[k].atmo;
  a.sky = new THREE.Color(a.sky); a.hemiSky = new THREE.Color(a.hemiSky);
  a.hemiGround = new THREE.Color(a.hemiGround); a.sun = new THREE.Color(a.sun);
  a.spark = new THREE.Color(a.spark);
}

// world layout: biome centres along +x (spawn at 0). Bands blend gradually between centres.
const LAYOUT = { order: ['shallows', 'ruins', 'drift'], centers: [0, 50, 100] };   // walkable spacing (was 200 apart → unreachable)
const LABELS = { shallows: 'I · HOME MEADOW', ruins: 'II · WIDE PASTURES', drift: 'III · OLD ORCHARD' };
export function biomeNameAt(x) {
  const C = LAYOUT.centers, O = LAYOUT.order;
  let best = 0, bd = Infinity;
  for (let i = 0; i < C.length; i++) { const d = Math.abs(x - C[i]); if (d < bd) { bd = d; best = i; } }
  return LABELS[O[best]];
}

const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// blended biome descriptor at world x (cached by coarse x so per-vertex build is cheap)
const _cache = new Map();
function biomeAt(x) {
  const key = Math.round(x / 2);
  let d = _cache.get(key);
  if (d) return d;
  const C = LAYOUT.centers, O = LAYOUT.order;
  let A, B, t;
  if (x <= C[0]) { A = B = BIOMES[O[0]]; t = 0; }
  else if (x >= C[C.length - 1]) { A = B = BIOMES[O[O.length - 1]]; t = 0; }
  else { let i = 0; while (i < C.length - 1 && x > C[i + 1]) i++; A = BIOMES[O[i]]; B = BIOMES[O[i + 1]]; t = smooth((x - C[i]) / (C[i + 1] - C[i])); }
  if (A === B) d = A;
  else {
    const scatter = [...A.scatter.map(([n, w]) => [n, w * (1 - t)]), ...B.scatter.map(([n, w]) => [n, w * t])];
    d = {
      amp: lerp(A.amp, B.amp, t), amp2: lerp(A.amp2, B.amp2, t), base: lerp(A.base, B.base, t),
      detail: lerp(A.detail, B.detail, t), water: lerp(A.water, B.water, t),
      scatterDensity: lerp(A.scatterDensity, B.scatterDensity, t),
      grass: lerp3(A.grass, B.grass, t), grassHi: lerp3(A.grassHi, B.grassHi, t),
      rock: lerp3(A.rock, B.rock, t), sand: lerp3(A.sand, B.sand, t),
      scatter,
      atmo: {
        sky: new THREE.Color(A.atmo.sky).lerp(new THREE.Color(B.atmo.sky), t),
        fog: lerp(A.atmo.fog, B.atmo.fog, t),
        hemiSky: new THREE.Color(A.atmo.hemiSky).lerp(new THREE.Color(B.atmo.hemiSky), t),
        hemiI: lerp(A.atmo.hemiI, B.atmo.hemiI, t),
        hemiGround: new THREE.Color(A.atmo.hemiGround).lerp(new THREE.Color(B.atmo.hemiGround), t),
        sun: new THREE.Color(A.atmo.sun).lerp(new THREE.Color(B.atmo.sun), t),
        sunI: lerp(A.atmo.sunI, B.atmo.sunI, t),
        spark: new THREE.Color(A.atmo.spark).lerp(new THREE.Color(B.atmo.spark), t),
      },
    };
  }
  _cache.set(key, d);
  return d;
}
function heightWith(b, x, z) {
  let h = b.amp * (fbm(x * FREQ + 11, z * FREQ + 7) - 0.5) * 2;
  h += b.amp2 * (fbm(x * FREQ2 + 30, z * FREQ2 + 19) - 0.5) * 2;
  h += (b.detail || 0) * (fbm(x * 0.16 + 60, z * 0.16 + 44) - 0.5) * 2;
  return h + b.base;
}
function baseHeightAt(x, z) { return heightWith(biomeAt(x), x, z); }

// ---------------------------------------------------------------- terrain features (H-167)
// Bounded lakes, gorge cuts and mountain masses on a deterministic feature grid.
// STRUCTURAL ROUTE GUARANTEE: every feature fits inside its cell with a walkable
// MARGIN on all four sides, so the strips along cell boundaries are always plain
// ground — any blocker can be rounded to its north AND south, and the eastward
// pilgrimage can never be sealed. Protected discs (spawn, shrine arenas) drop a
// cell's feature entirely. Everything is a pure function of world position, so
// height, rendering, collision and the class queries can never disagree.
export const TERRAIN = Object.freeze({
  CELL: 84, MARGIN: 12,
  DEEP_DEPTH: 0.55,                                    // water deeper than this is 'deep': ground enemies stop, the player walks on down
  LAKE_CORE: -4.6, LAKE_SHALLOW: -0.32, LAKE_SHORE: 0.5,
  GORGE_DEPTH: 5.5, GORGE_HALF: 3.2, GORGE_WALL: 2.4, GORGE_BLOCK: 0.85,
  GORGE_RAMP: 9, GORGE_STEP: 0.45,                     // carved stair entrances at both gorge ends
  CLIMB: 0.05,                                         // player wall rule: full-depth gorge walls pass only level-or-descending (any real rise blocks)
  MOUNT_BLOCK: 2.0,
});
const HARD = Object.freeze({ deep: 1, gorge: 1, mountain: 1 });
const PROTECTED = [{ x: 0, z: 0, r: 26 }];             // spawn clearing; the game adds its shrine arenas
export function setProtectedRegions(list) {
  PROTECTED.length = 0;
  for (const p of list || []) PROTECTED.push({ x: +p.x || 0, z: +p.z || 0, r: +p.r || 0 });
  _feat.clear();
}
const _feat = new Map();
function featureAt(cx, cz) {
  const key = cx + ',' + cz;
  if (_feat.has(key)) return _feat.get(key);
  let f = null;
  if (hash01(cx * 3 + 1013, cz * 3 - 707) < 0.62) {    // ~62% of cells hold one feature
    const maxR = TERRAIN.CELL / 2 - TERRAIN.MARGIN;
    const rr = hash01(cx * 11 + 17, cz * 11 + 71), tr = hash01(cx * 13 + 5, cz * 13 + 29);
    const jx = hash01(cx * 5 + 331, cz * 5 + 11), jz = hash01(cx * 7 + 97, cz * 7 + 53);
    const r = maxR * (0.5 + 0.45 * rr);
    const x = (cx + 0.5) * TERRAIN.CELL + (jx - 0.5) * 2 * (maxR - r);   // influence disc stays inside the margin box
    const z = (cz + 0.5) * TERRAIN.CELL + (jz - 0.5) * 2 * (maxR - r);
    const type = tr < 0.40 ? 'lake' : tr < 0.72 ? 'gorge' : 'mountain';
    f = { type, x, z, r };
    if (type === 'lake') f.waterY = baseHeightAt(x, z) - 0.25;
    else if (type === 'gorge') { f.angle = hash01(cx * 17 + 3, cz * 17 + 9) * Math.PI; f.len = r - TERRAIN.GORGE_HALF - TERRAIN.GORGE_WALL; }
    else f.amp = 5.5 + rr * 3;
    for (const p of PROTECTED) if (Math.hypot(x - p.x, z - p.z) < r + p.r) { f = null; break; }
  }
  _feat.set(key, f);
  return f;
}
function featureNear(x, z) { return featureAt(Math.floor(x / TERRAIN.CELL), Math.floor(z / TERRAIN.CELL)); }
// capsule coordinates around a gorge's centre segment: q = distance to the segment,
// along = unclamped axial position (drives the stepped entrance tapers at both ends)
function gorgeLocal(f, x, z) {
  const ax = Math.cos(f.angle), az = Math.sin(f.angle);
  const lx = x - f.x, lz = z - f.z;
  const raw = lx * ax + lz * az;
  const along = Math.max(-f.len, Math.min(f.len, raw));
  return { q: Math.hypot(lx - along * ax, lz - along * az), along: raw };
}
function gorgeDist(f, x, z) { return gorgeLocal(f, x, z).q; }
// how much of the full gorge depth applies at this axial position: 1 in the main cut,
// easing to 0 across the last GORGE_RAMP units of each end — the walk-in entrances
function gorgeAxialScale(f, along) {
  return smooth(Math.max(0, Math.min(1, (f.len - Math.abs(along)) / TERRAIN.GORGE_RAMP)));
}
// radial lake profile relative to the water plane: deep core → shallow wading
// ring → dry shore. Fixed in t = d/r, so the deep boundary sits at t≈0.45 and the
// shoreline at t≈0.70 for EVERY lake (the water shader mirrors the same profile).
function lakeProfile(t) {
  if (t < 0.62) return lerp(TERRAIN.LAKE_CORE, TERRAIN.LAKE_SHALLOW, smooth(t / 0.62));
  return lerp(TERRAIN.LAKE_SHALLOW, TERRAIN.LAKE_SHORE, smooth(Math.min(1, (t - 0.62) / 0.18)));
}
export function terrainHeightAt(x, z) {
  const h = baseHeightAt(x, z), f = featureNear(x, z);
  if (!f) return h;
  if (f.type === 'gorge') {
    const { q, along } = gorgeLocal(f, x, z);
    if (q >= TERRAIN.GORGE_HALF + TERRAIN.GORGE_WALL) return h;
    const radial = q < TERRAIN.GORGE_HALF ? 1 : 1 - smooth((q - TERRAIN.GORGE_HALF) / TERRAIN.GORGE_WALL);
    const axial = gorgeAxialScale(f, along);
    let drop = TERRAIN.GORGE_DEPTH * radial * axial;
    // entrance tapers are quantized into carved stair treads (each under the player's
    // CLIMB limit), so both gorge ends are walkable descents into the cut
    if (axial > 0 && axial < 1) drop = Math.round(drop / TERRAIN.GORGE_STEP) * TERRAIN.GORGE_STEP;
    return h - drop;
  }
  const d = Math.hypot(x - f.x, z - f.z);
  if (d >= f.r) return h;
  if (f.type === 'mountain') return h + f.amp * Math.pow(smooth(1 - d / f.r), 1.5);
  const t = d / f.r;                                   // lake
  if (t < 0.80) return f.waterY + lakeProfile(t);
  return lerp(f.waterY + TERRAIN.LAKE_SHORE, h, smooth((t - 0.80) / 0.20));
}
// classification is closed-form wherever possible (no noise evaluation), so the
// per-frame passability queries of a full crowd stay near-free.
export function terrainClassAt(x, z) {
  const f = featureNear(x, z);
  if (!f) return 'ground';
  if (f.type === 'gorge') return gorgeDist(f, x, z) < TERRAIN.GORGE_HALF + TERRAIN.GORGE_WALL * TERRAIN.GORGE_BLOCK ? 'gorge' : 'ground';
  const d = Math.hypot(x - f.x, z - f.z);
  if (d >= f.r) return 'ground';
  if (f.type === 'mountain') {
    return f.amp * Math.pow(smooth(1 - d / f.r), 1.5) > TERRAIN.MOUNT_BLOCK ? 'mountain' : 'ground';
  }
  const t = d / f.r;
  const depth = t < 0.80 ? -lakeProfile(t) : f.waterY - terrainHeightAt(x, z);   // blend ring: the real height decides
  return depth > TERRAIN.DEEP_DEPTH ? 'deep' : depth > 0.02 ? 'shallow' : 'ground';
}
export function waterLevelAt(x, z) {
  const f = featureNear(x, z);
  return f && f.type === 'lake' && Math.hypot(x - f.x, z - f.z) < f.r ? f.waterY : null;
}
export function passableAt(x, z, tag = 'ground', y = null) {
  if (tag === 'flying') return true;
  const cls = terrainClassAt(x, z);
  if (!HARD[cls]) return true;
  // H-167 follow-up: the player experiences gorges as real 3D space, by zone:
  //   - entrance tapers (0 < axial < 1) are TERRACED by the stair quantization, so
  //     stair-sized rises climb there — in, out, and up the terraced bowl sides
  //   - the full-depth floor is plain standing space
  //   - full-depth mid-cut walls are continuous and sheer: pass only
  //     level-or-descending (H ≤ feet + CLIMB), so any walk/dash/knockback can drop
  //     IN off the rim or ski DOWN the face, but per-frame creep can never scale
  //     the wall back up (a jump gains height first and may scramble a ledge —
  //     deliberate skill room). Ground enemies keep the absolute block throughout.
  // the player walks straight down into lake basins: the gentle carved bowl needs no
  // wall rule — 'deep' only ever gates ground enemies, who stop at the shallow line
  if (tag === 'player' && cls === 'deep') return true;
  if (tag === 'player' && cls === 'gorge' && y != null) {
    const f = featureNear(x, z);
    if (!f || f.type !== 'gorge') return false;
    const { q, along } = gorgeLocal(f, x, z);
    const axial = gorgeAxialScale(f, along);
    if (axial <= 0) return true;                         // beyond the mouths: plain ground
    const rise = terrainHeightAt(x, z) - y;
    if (axial < 1) return rise <= TERRAIN.GORGE_STEP + 0.1;   // terraced entrance bowl
    if (q < TERRAIN.GORGE_HALF) return true;             // the floor of the cut
    return rise <= TERRAIN.CLIMB;                        // sheer wall: descend-only
  }
  return false;
}
// swept passability: walk the segment in ≤0.3-unit samples and stop just before
// the first hard-terrain sample, so no speed (dash, knockback, charge, lunge) can
// tunnel into or across a boundary. A mover that already stands inside hard
// terrain (teleport hooks, old saves) is never trapped: its moves stay free.
export function sweepTerrain(x0, z0, x1, z1, tag = 'ground', y = null) {
  if (tag === 'flying' || !passableAt(x0, z0, tag, y)) return { x: x1, z: z1, blocked: false };
  const dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x: x0, z: z0, blocked: false };
  const steps = Math.max(1, Math.ceil(dist / 0.3));
  let px = x0, pz = z0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, nx = x0 + dx * t, nz = z0 + dz * t;
    if (!passableAt(nx, nz, tag, y)) return { x: px, z: pz, blocked: true };
    px = nx; pz = nz;
  }
  return { x: px, z: pz, blocked: false };
}
// nearest passable point by ring probing — spawn/teleport/save-migration safety net
export function findPassableNear(x, z, tag = 'ground', maxR = 30, y = null) {
  if (passableAt(x, z, tag, y)) return { x, z };
  for (let r = 1; r <= maxR; r++) {
    const n = Math.max(8, Math.round(r * 6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283, nx = x + Math.cos(a) * r, nz = z + Math.sin(a) * r;
      if (passableAt(nx, nz, tag, y)) return { x: nx, z: nz };
    }
  }
  return null;
}
export function featuresIn(x0, z0, x1, z1) {
  const out = [];
  for (let cx = Math.floor(Math.min(x0, x1) / TERRAIN.CELL); cx <= Math.floor(Math.max(x0, x1) / TERRAIN.CELL); cx++)
    for (let cz = Math.floor(Math.min(z0, z1) / TERRAIN.CELL); cz <= Math.floor(Math.max(z0, z1) / TERRAIN.CELL); cz++) {
      const f = featureAt(cx, cz);
      if (f) out.push({ type: f.type, x: f.x, z: f.z, r: f.r, waterY: f.waterY ?? null, angle: f.angle ?? null, len: f.len ?? null });
    }
  return out;
}

// ---------------------------------------------------------------- kit loading
export function loadKit(gltfScene) {
  const kitGeo = {};
  gltfScene.updateMatrixWorld(true);
  gltfScene.traverse(o => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); kitGeo[o.name] = g; } });
  return kitGeo;
}

// ---------------------------------------------------------------- the streamed world
export class ProcWorld {
  constructor(scene, kitGeo, { CHUNK = 16, RES = 1, RADIUS = 4 } = {}) {
    this.scene = scene; this.kitGeo = kitGeo; this.CHUNK = CHUNK; this.RES = RES; this.RADIUS = RADIUS;
    this.chunks = new Map();
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._s = new THREE.Vector3(); this._v = new THREE.Vector3(); this._c = new THREE.Color();
    this.uniforms = {
      uTime: { value: 0 }, uSky: { value: new THREE.Color(0x9ec7f2) }, uSunDir: { value: new THREE.Vector3(8, 16, -6).normalize() },
      uSunDirV: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },   // sun dir in VIEW space (set per frame by the game)
      uHorizon: { value: new THREE.Color(0xffd9a0) },                      // warm sun-side tint for rim light + far fog
    };
    this.terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
    this.kitMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    this._wind(this.kitMat, { amp: 0.05, feet: 0.35 });   // trees/reeds sway at the top; rocks (low) barely move
    // soft-foliage material: flatShading MUST be false or the radial "billow" normals
    // baked by build_kit.py are discarded (flat shading recomputes face normals in-shader)
    this.kitSoftMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    this._wind(this.kitSoftMat, { amp: 0.05, feet: 0.35 });
    this.glowMats = {
      crystal: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.25, emissive: 0x2ec8e0, emissiveIntensity: 1.5 }),
      mushroom: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, emissive: 0xc0407a, emissiveIntensity: 0.8 }),
    };
    this._fresnel(this.glowMats.crystal, 0x9ffcff, 1.8);   // rim-glow so crystals read as lit from within
    this._wind(this.glowMats.mushroom, { amp: 0.035, feet: 0.2 });
    // grass ground cover — crossed-quad tufts, gradient-shaded, wind-animated
    this.grassGeo = this._grassGeo();
    this.grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    this._wind(this.grassMat, { amp: 0.22, feet: 0.0, speed: 1.25 });
    this._cloudShadows(this.terrainMat);               // drifting soft cloud shadows on the ground
    // Journey pass: warm sun-wrap rim on silhouettes, horizon-glow far fog, ground glitter
    this._sunRim(this.kitMat, 0.5, 2.6);
    this._sunRim(this.kitSoftMat, 0.55, 2.4);
    this._sunRim(this.grassMat, 0.45, 2.2);
    this._sunRim(this.terrainMat, 0.22, 3.0);
    for (const m of [this.terrainMat, this.kitMat, this.kitSoftMat, this.grassMat, this.glowMats.crystal, this.glowMats.mushroom]) this._warmFog(m);
    this._sparkle(this.terrainMat, 3.5);               // after _cloudShadows — reuses its vWorld varying
    // gradient sky dome following the player
    this.sky = this._makeSky();
    scene.add(this.sky);
    this.rays = this._godrays();
    scene.add(this.rays);
    this.aurora = this._makeAurora();                  // night-sky light ribbons (Drift only)
    scene.add(this.aurora);
    // bounded water: one disc mesh per streamed lake basin (H-167). The shader
    // mirrors the analytic lake profile, so the DEEP hard-block boundary (t≈0.45)
    // and the shoreline (t≈0.70) are visible before collision ever matters.
    this.lakes = new Map();
    this.waterGeo = new THREE.CircleGeometry(1, 48);
    this.waterMat = this._makeWaterMat();
    // atmospheric motes — pollen / dust / spores drifting around the player
    this.motes = this._makeMotes(280, 34);
    scene.add(this.motes);
    // weather precipitation (hidden until setWeather)
    this.rain = this._makePrecip('rain'); scene.add(this.rain);
    this.snow = this._makePrecip('snow'); scene.add(this.snow);
    this._weather = 'clear';
  }

  setWeather(kind) { this._weather = kind; this.rain.visible = kind === 'rain' || kind === 'storm'; this.snow.visible = kind === 'snow'; }

  // lake surface: unit disc scaled to each basin. t = distance from centre (0..1)
  // matches the terrain carve profile, so the readable colour bands ARE the rules:
  // pale wading ring (passable) → bright boundary line → dark deep core (blocked).
  _makeWaterMat() {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,   // the surface must read from BELOW too — the pilot walks under it
      uniforms: { uTime: this.uniforms.uTime, uSky: this.uniforms.uSky },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uTime; uniform vec3 uSky; varying vec2 vP;
        void main(){
          float t = length(vP);
          float deep = 1.0 - smoothstep(0.47, 0.60, t);                     // enemy stop-line sits at t≈0.54 with the walk-down basin
          vec3 shallowCol = mix(vec3(0.30, 0.62, 0.66), uSky, 0.35);
          vec3 deepCol = vec3(0.05, 0.13, 0.30);
          vec3 col = mix(shallowCol, deepCol, deep);
          float ripple = sin(t * 34.0 - uTime * 1.4) * 0.5 + sin(t * 19.0 - uTime * 0.9 + vP.x * 2.0) * 0.5;
          col += ripple * 0.02;
          float deepEdge = smoothstep(0.022, 0.0, abs(t - 0.536));          // bright line marks the enemy stop boundary
          col = mix(col, vec3(0.62, 0.86, 1.0), deepEdge * 0.35);
          float foam = smoothstep(0.045, 0.0, abs(t - 0.695 + sin(uTime * 0.8 + vP.y * 1.7) * 0.008));
          col = mix(col, vec3(0.92, 0.97, 1.0), foam * 0.65);
          // the surface stays see-through so the pilot reads as they walk under it
          float a = mix(0.38, 0.6, deep) * max(smoothstep(0.78, 0.70, t), foam);
          gl_FragColor = vec4(col, a);
        }`,
    });
  }
  _streamLakes(px, pz) {
    const pcx = Math.floor(px / TERRAIN.CELL), pcz = Math.floor(pz / TERRAIN.CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cx = pcx + i, cz = pcz + j, key = cx + ',' + cz;
      if (this.lakes.has(key)) continue;
      const f = featureAt(cx, cz);
      if (!f || f.type !== 'lake') continue;
      const m = new THREE.Mesh(this.waterGeo, this.waterMat);
      m.rotation.x = -Math.PI / 2; m.scale.set(f.r, f.r, 1);
      m.position.set(f.x, f.waterY, f.z);
      m.renderOrder = 1;
      this.scene.add(m); this.lakes.set(key, m);
    }
    for (const [key, m] of this.lakes) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - pcx) > 2 || Math.abs(cz - pcz) > 2) { this.scene.remove(m); this.lakes.delete(key); }
    }
  }

  // falling precipitation that follows the player: rain = fast bluish streaks, snow = slow drifting flakes
  _makePrecip(mode) {
    const rain = mode === 'rain', count = rain ? 2400 : 900, EXT = 24, H = 26;
    const pos = new Float32Array(count * 3), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * EXT; pos[i * 3 + 1] = Math.random() * H; pos[i * 3 + 2] = (Math.random() * 2 - 1) * EXT; seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: this.uniforms.uTime, uH: { value: H }, uExt: { value: EXT }, uPix: { value: innerHeight || 900 },
        uColor: { value: new THREE.Color(rain ? 0xd6e6f6 : 0xffffff) }, uFall: { value: rain ? 32.0 : 3.2 },
        uDrift: { value: rain ? 0.4 : 1.8 }, uStreak: { value: rain ? 1.0 : 0.0 }, uSize: { value: rain ? 0.13 : 0.022 },
      },
      vertexShader: `uniform float uTime,uH,uExt,uPix,uFall,uDrift,uSize; attribute float seed;
        void main(){
          float px = position.x + sin(uTime*0.4 + seed*6.28)*uDrift;
          float pz = position.z + cos(uTime*0.35 + seed*4.0)*uDrift;
          float py = mod(position.y - uTime*uFall - seed*7.0, uH);
          px = mod(px+uExt, 2.0*uExt)-uExt; pz = mod(pz+uExt, 2.0*uExt)-uExt;
          vec4 mv = modelViewMatrix * vec4(px, py, pz, 1.0);
          gl_PointSize = uPix * uSize / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uStreak;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float a = uStreak > 0.5
            ? smoothstep(0.5, 0.0, abs(d.x)*7.0) * smoothstep(0.5, 0.0, abs(d.y)) * 0.9      // rain streak (thin + tall)
            : smoothstep(0.5, 0.0, length(d)) * 0.9;                                          // snow flake
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; pts.visible = false;
    return pts;
  }

  // gradient sky: back-side sphere, horizon = biome sky colour, zenith darker, plus a
  // glowing sun disc + halo (bloom catches it) in the sun direction.
  _makeSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uHorizon: this.uniforms.uSky, uZenith: { value: new THREE.Color(0x223) },
        uSunDir: this.uniforms.uSunDir, uSunCol: { value: new THREE.Color(0xfff2dd) },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 uHorizon, uZenith, uSunDir, uSunCol; varying vec3 vDir;
        void main(){
          float h = smoothstep(-0.03, 0.6, vDir.y);
          vec3 col = mix(uHorizon, uZenith, h);
          float sd = dot(normalize(vDir), normalize(uSunDir));
          col += uSunCol * (smoothstep(0.9965, 0.9992, sd) * 2.2 + pow(max(sd, 0.0), 90.0) * 0.9 + pow(max(sd, 0.0), 8.0) * 0.12);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.skyMat = mat;
    const m = new THREE.Mesh(new THREE.SphereGeometry(200, 24, 16), mat);
    m.renderOrder = -1; m.frustumCulled = false;
    return m;
  }

  // volumetric-ish light shafts: soft additive cones angled from the sun, biome-tinted,
  // following the player and fading out at night (low sun intensity).
  _godrays() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.03, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.rayMat = mat;
    const g = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 30, 8, 1, true), mat);
      const a = Math.random() * 6.283, r = 16 + Math.random() * 34;
      cone.position.set(Math.cos(a) * r, 12, Math.sin(a) * r);
      cone.rotation.set(-0.28, 0.5, 0.34);                      // ALL parallel → reads as sun shafts, not fog
      cone.renderOrder = 2;
      g.add(cone);
    }
    g.frustumCulled = false;
    return g;
  }

  // aurora: additive light curtains high in the sky, flowing green→violet, only lit in Drift
  _makeAurora() {
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uTime: this.uniforms.uTime, uOpacity: { value: 0 } },
      vertexShader: `varying vec2 vUv; uniform float uTime;
        void main(){ vUv = uv; vec3 p = position; p.z += sin(p.x*0.045 + uTime*0.2)*9.0 + sin(p.x*0.11 - uTime*0.13)*4.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float uTime, uOpacity;
        void main(){
          float b = sin(vUv.x*20.0 + uTime*0.6 + sin(vUv.x*6.0 + uTime*0.3)*2.2);
          float curtain = smoothstep(0.25, 0.95, b*0.5 + 0.5);
          float vfade = smoothstep(0.0, 0.4, vUv.y) * smoothstep(1.0, 0.5, vUv.y);
          vec3 col = mix(vec3(0.25,0.95,0.6), vec3(0.55,0.35,0.98), smoothstep(0.15,0.85, vUv.x + sin(uTime*0.1)*0.2));
          gl_FragColor = vec4(col, curtain * vfade * uOpacity);
        }`,
    });
    this.auroraMat = mat;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(300, 90, 56, 6), mat);
    m.rotation.x = -Math.PI * 0.28;
    m.position.y = 34; m.renderOrder = -1; m.frustumCulled = false;
    return m;
  }

  _makeMotes(count, extent) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * extent;
      pos[i * 3 + 1] = 0.5 + Math.random() * extent * 0.5;
      pos[i * 3 + 2] = (Math.random() * 2 - 1) * extent;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.uniforms.uTime, uColor: { value: new THREE.Color(0xffffff) }, uExtent: { value: extent }, uPix: { value: innerHeight || 900 } },
      vertexShader: `
        uniform float uTime, uExtent, uPix; attribute float seed; varying float vA;
        void main(){
          float px = position.x + sin(uTime*0.25 + seed*6.28)*2.5;
          float pz = position.z + cos(uTime*0.22 + seed*3.7)*2.5;
          px = mod(px + uExtent, 2.0*uExtent) - uExtent;      // wrap into the box so motes never drift away
          pz = mod(pz + uExtent, 2.0*uExtent) - uExtent;
          float py = position.y + sin(uTime*0.3 + seed*10.0)*1.2;
          vec4 mv = modelViewMatrix * vec4(px, py, pz, 1.0);
          gl_PointSize = uPix * 0.006 * (0.6 + 0.8*seed) / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
          vA = 0.3 + 0.5*sin(uTime*0.5 + seed*20.0);          // slow twinkle
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)) * max(vA, 0.0); gl_FragColor = vec4(uColor, a); }`,
    });
    this.motesMat = mat;
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  // stack a shader injector onto a material — onBeforeCompile is a SINGLE slot, so
  // assigning it twice silently drops the first effect; this chains them instead.
  _inject(mat, fn) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = prev ? (sh, r) => { prev(sh, r); fn(sh, r); } : fn;
    mat.needsUpdate = true;
  }

  // inject a cheap wind sway into a MeshStandardMaterial (instanced pieces only), keeping
  // all of Standard's lighting/shadows/fog. Sway grows with height above `feet`.
  _wind(mat, { amp = 0.05, feet = 0.3, speed = 1.0 } = {}) {
    this._inject(mat, (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        `#include <begin_vertex>
         #ifdef USE_INSTANCING
         {
           vec3 wp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
           float ph = wp.x * 0.55 + wp.z * 0.55;
           float hh = max(transformed.y - ${feet.toFixed(3)}, 0.0);
           transformed.x += sin(uTime * ${(1.6 * speed).toFixed(3)} + ph) * ${amp.toFixed(3)} * hh;
           transformed.z += cos(uTime * ${(1.25 * speed).toFixed(3)} + ph * 1.13) * ${(amp * 0.7).toFixed(3)} * hh;
         }
         #endif`);
    });
  }

  // drifting cloud shadows: darken the ground by a slow scrolling noise of world xz
  _cloudShadows(mat) {
    this._inject(mat, (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.vertexShader = 'varying vec3 vWorld;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'uniform float uTime; varying vec3 vWorld;\n' + sh.fragmentShader.replace('#include <color_fragment>',
        `#include <color_fragment>
         {
           vec2 uv = vWorld.xz * 0.018 + vec2(uTime * 0.012, uTime * 0.008);
           float c = sin(uv.x) * sin(uv.y) + 0.5 * sin(uv.x * 2.1 + 1.3) * sin(uv.y * 1.7 - 0.6);
           diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(-0.3, 0.5, c));
         }`);
    });
  }

  // add a view-angle rim glow (Fresnel) on top of a material's emissive
  _fresnel(mat, colorHex, power) {
    const col = new THREE.Color(colorHex);
    this._inject(mat, (sh) => {
      sh.uniforms.uRim = { value: col };
      sh.vertexShader = 'varying vec3 vViewN; varying vec3 vViewP;\n' +
        sh.vertexShader.replace('#include <project_vertex>',
          '#include <project_vertex>\n vViewN = normalize(transformedNormal); vViewP = mvPosition.xyz;');
      sh.fragmentShader = 'uniform vec3 uRim; varying vec3 vViewN; varying vec3 vViewP;\n' +
        sh.fragmentShader.replace('#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float rim = pow(1.0 - abs(dot(normalize(vViewN), normalize(-vViewP))), ${power.toFixed(1)});
           totalEmissiveRadiance += uRim * rim * 1.6;`);
    });
  }

  _declareFrag(sh, decl) { if (!sh.fragmentShader.includes(decl)) sh.fragmentShader = decl + '\n' + sh.fragmentShader; }

  // warm sun-wrap rim: silhouettes glow sun-coloured on their lit side (Journey backlight).
  // Fragment-only — `normal` (view space) and vViewPosition both exist at emissivemap_fragment.
  _sunRim(mat, strength = 0.5, power = 2.6) {
    this._inject(mat, (sh) => {
      sh.uniforms.uSunDirV = this.uniforms.uSunDirV;
      sh.uniforms.uHorizon = this.uniforms.uHorizon;
      this._declareFrag(sh, 'uniform vec3 uSunDirV;');
      this._declareFrag(sh, 'uniform vec3 uHorizon;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3 rimN = normalize(normal); vec3 rimV = normalize(vViewPosition);
           float rimF = pow(1.0 - max(dot(rimN, rimV), 0.0), ${power.toFixed(1)});
           float sunW = 0.25 + 0.75 * max(dot(rimN, uSunDirV), 0.0);
           totalEmissiveRadiance += uHorizon * rimF * sunW * ${strength.toFixed(2)};
         }`);
    });
  }

  // horizon glow: far fog warms toward the sun tint instead of flat single-colour murk
  _warmFog(mat) {
    this._inject(mat, (sh) => {
      sh.uniforms.uHorizon = this.uniforms.uHorizon;
      this._declareFrag(sh, 'uniform vec3 uHorizon;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>',
        `#ifdef USE_FOG
           #ifdef FOG_EXP2
             float fogFac = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
           #else
             float fogFac = smoothstep(fogNear, fogFar, vFogDepth);
           #endif
           vec3 fogCol = mix(fogColor, uHorizon, smoothstep(18.0, 70.0, vFogDepth) * 0.45);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFac);
         #endif`);
    });
  }

  // Journey glitter: rare per-cell micro-normals glint into the camera and bloom.
  // Terrain only — chained AFTER _cloudShadows so its vWorld varying already exists.
  _sparkle(mat, gain = 3.5) {
    this._inject(mat, (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      sh.uniforms.uHorizon = this.uniforms.uHorizon;
      this._declareFrag(sh, 'uniform vec3 uHorizon;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec2 gCell = floor(vWorld.xz * 5.0);
           float g1 = fract(sin(dot(gCell, vec2(127.1, 311.7))) * 43758.5453);
           float g2 = fract(g1 * 137.13);
           // each glint is a TINY disc inside its cell (flat-shaded faces share one normal,
           // so without this the whole face lights up as a big square)
           vec2 gOff = vec2(fract(g1 * 91.7), fract(g2 * 73.3)) * 0.6 + 0.2;
           float gDist = length(fract(vWorld.xz * 5.0) - gOff);
           float gDot = smoothstep(0.10, 0.03, gDist);
           float tw = smoothstep(0.3, 0.85, 0.5 + 0.5 * sin(uTime * (0.7 + g2 * 1.4) + g1 * 40.0));
           vec3 gN = normalize(normalize(normal) + (vec3(g1, fract(g1 * 57.3), g2) - 0.5) * 0.9);
           float glint = pow(max(dot(gN, normalize(vViewPosition)), 0.0), 24.0);
           totalEmissiveRadiance += uHorizon * gDot * glint * step(0.72, g2) * tw * ${gain.toFixed(1)};
         }`);
    });
  }

  _grassGeo() {
    const pos = [], col = [], w = 0.06, h = 0.36, base = [0.34, 0.40, 0.31], tip = [0.64, 0.72, 0.56];
    const quad = (yaw) => {
      const c = Math.cos(yaw), s = Math.sin(yaw), tw = w * 0.22;
      const bl = [-w * c, 0, -w * s], br = [w * c, 0, w * s], tl = [-tw * c, h, -tw * s], tr = [tw * c, h, tw * s];
      const tris = [bl, br, tr, bl, tr, tl, br, bl, tr, tr, bl, tl];
      const cc = [base, base, tip, base, tip, tip, base, base, tip, tip, base, tip];
      for (let i = 0; i < tris.length; i++) { pos.push(...tris[i]); col.push(...cc[i]); }
    };
    quad(0); quad(Math.PI / 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    // BotW grass trick: all blade normals point UP so blades take the ground's lighting
    // (no near-black backfaces on the far side of every card)
    const na = g.attributes.normal;
    for (let i = 0; i < na.count; i++) na.setXYZ(i, 0, 1, 0);
    return g;
  }

  _grass(ox, oz) {
    const step = 0.9, arr = [];
    for (let x = ox; x < ox + this.CHUNK; x += step) for (let z = oz; z < oz + this.CHUNK; z += step) {
      const r1 = hash01(Math.floor(x * 13.1), Math.floor(z * 7.7));
      if (r1 < 0.32) continue;                          // sparse gaps
      const r2 = hash01(Math.floor(x * 4.3 + 3), Math.floor(z * 9.1 + 8));
      const px = x + (r1 - 0.5) * step, pz = z + (r2 - 0.5) * step;
      const b = biomeAt(px), h = this.heightAt(px, pz);
      if (terrainClassAt(px, pz) !== 'ground' || this.slopeAt(px, pz) > 1.1) continue;   // no grass in water, gorges or mountain cores
      arr.push([px, h - 0.02, pz, r1 * 6.283, 0.7 + r2 * 0.7, b.grassHi, r2]);
    }
    const inst = new THREE.InstancedMesh(this.grassGeo, this.grassMat, arr.length);
    inst.receiveShadow = true;
    arr.forEach(([x, y, z, yaw, sc, tintArr, rv], k) => {
      this._e.set(0, yaw, 0); this._q.setFromEuler(this._e); this._s.set(sc, sc, sc);
      this._m.compose(this._v.set(x, y, z), this._q, this._s);
      inst.setMatrixAt(k, this._m);
      const v = 0.84 + rv * 0.16;
      inst.setColorAt(k, this._c.setRGB(tintArr[0] * v, tintArr[1] * v, tintArr[2] * v));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    return inst;
  }

  biomeAt(x) { return biomeAt(x); }
  biomeName(x) { return biomeNameAt(x); }
  heightAt(x, z) { return terrainHeightAt(x, z); }
  slopeAt(x, z) { const e = 0.6; return Math.hypot(this.heightAt(x + e, z) - this.heightAt(x - e, z), this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e); }
  atmoAt(x) { return biomeAt(x).atmo; }
  // ---- H-167 terrain authority: one deterministic classification beside heightAt ----
  terrainAt(x, z) { return { cls: terrainClassAt(x, z), height: terrainHeightAt(x, z), waterY: waterLevelAt(x, z) }; }
  passableAt(x, z, tag = 'ground', y = null) { return passableAt(x, z, tag, y); }
  sweep(x0, z0, x1, z1, tag = 'ground', y = null) { return sweepTerrain(x0, z0, x1, z1, tag, y); }
  findPassable(x, z, tag = 'ground', maxR = 30, y = null) { return findPassableNear(x, z, tag, maxR, y); }
  waterLevelAt(x, z) { return waterLevelAt(x, z); }
  featuresIn(x0, z0, x1, z1) { return featuresIn(x0, z0, x1, z1); }

  _terrain(ox, oz) {
    const n = this.CHUNK / this.RES, R = this.RES, pos = [], col = [];
    const faceColor = (x, z) => {
      const b = biomeAt(x), h = this.heightAt(x, z), s = this.slopeAt(x, z);
      let c = lerp3(b.grass, b.grassHi, Math.min(1, Math.max(0, (h - b.base) / Math.max(0.5, b.amp))));
      if (s > 0.9) c = lerp3(c, b.rock, Math.min(1, (s - 0.9) / 0.8));
      const wy = waterLevelAt(x, z);                     // lake shores + floors shade to sand
      if (wy != null && h < wy + 0.35) c = lerp3(b.sand, c, Math.min(1, Math.max(0, (h - wy) / 0.35)));
      // the bed darkens toward deep blue-green with real water depth, so the basin
      // reads as a volume through the transparent surface instead of glaring sand
      if (wy != null && h < wy) c = lerp3(c, [0.07, 0.14, 0.19], Math.min(1, (wy - h) / 3.2) * 0.78);
      return c;
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x0 = ox + i * R, z0 = oz + j * R, x1 = x0 + R, z1 = z0 + R;
      const y00 = this.heightAt(x0, z0), y10 = this.heightAt(x1, z0), y11 = this.heightAt(x1, z1), y01 = this.heightAt(x0, z1);
      const push = (ax, ay, az, bx, by, bz, cx, cy, cz, cc) => { pos.push(ax, ay, az, bx, by, bz, cx, cy, cz); for (let k = 0; k < 3; k++) col.push(cc[0], cc[1], cc[2]); };
      // wound CCW-from-above → normals point +y (else FrontSide culls the ground)
      push(x0, y00, z0, x1, y11, z1, x1, y10, z0, faceColor(x0 + R * 0.66, z0 + R * 0.33));
      push(x0, y00, z0, x0, y01, z1, x1, y11, z1, faceColor(x0 + R * 0.33, z0 + R * 0.66));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, this.terrainMat);
    m.receiveShadow = true; m.castShadow = true;
    return m;
  }

  _scatter(ox, oz) {
    // blocking footprints per kit piece (local-space circles, scaled by the instance):
    // trunks and stone block; grass/reeds/mushrooms stay walk-through. Arches block at
    // their two legs so you can still walk beneath them.
    // Vertical clearance comes from each loaded GLB mesh's actual bounding box.
    // Hand-authored heights drifted far above several visible rocks/stumps, making
    // jumps that looked clean still collide with invisible upper volumes.
    const COLLIDE = {
      pine: [{ x: 0, z: 0, r: 0.3, h: 1.55 }], pine_dark: [{ x: 0, z: 0, r: 0.34, h: 1.75 }],
      rock_s: [{ x: 0, z: 0, r: 0.31, h: 0.42 }], rock_l: [{ x: 0, z: 0, r: 0.8, h: 0.73 }],
      stump: [{ x: 0, z: 0, r: 0.25, h: 0.43 }], crystal: [{ x: 0, z: 0, r: 0.3, h: 0.95 }],
      column: [{ x: 0, z: 0, r: 0.37, h: 1.78 }],
      arch: [{ x: -0.85, z: 0, r: 0.36, h: 1.98 }, { x: 0.85, z: 0, r: 0.36, h: 1.98 }],
      wall: [{ x: -0.6, z: 0, r: 0.44, h: 1.44 }, { x: 0.6, z: 0, r: 0.44, h: 1.44 }],
    };
    const colliders = [];
    const buckets = {}, jitter = 2.0;
    for (let x = ox; x < ox + this.CHUNK; x += jitter) {
      for (let z = oz; z < oz + this.CHUNK; z += jitter) {
        const r1 = hash01(Math.floor(x * 7.3), Math.floor(z * 7.3));
        const r2 = hash01(Math.floor(x * 3.1 + 99), Math.floor(z * 5.7 + 12));
        const r3 = hash01(Math.floor(x * 9.7 + 5), Math.floor(z * 2.3 + 40));
        const densityRoll = hash01(Math.floor(x * 11.9 + 71), Math.floor(z * 13.7 + 29));
        const px = x + (r1 - 0.5) * jitter, pz = z + (r2 - 0.5) * jitter;
        const b = biomeAt(px), h = this.heightAt(px, pz);
        const cls = terrainClassAt(px, pz);
        if (HARD[cls]) continue;                        // nothing grows in deep water, gorges or mountain cores
        if (this.slopeAt(px, pz) > 1.5) continue;
        if (Math.hypot(px, pz) < 5 || densityRoll > b.scatterDensity) continue;
        let roll = r3, chosen = null;
        for (const [name, w] of b.scatter) { if (roll < w) { chosen = name; break; } roll -= w; }
        if (!chosen || !this.kitGeo[chosen]) continue;
        if (cls === 'shallow' && chosen !== 'reed') continue;   // only reeds stand in the wading ring
        const wy = waterLevelAt(px, pz);
        const near = wy != null && h < wy + 0.6;
        if (chosen === 'reed' && !near) continue;
        if (chosen === 'pine' && near) continue;
        const struct = (chosen === 'column' || chosen === 'wall' || chosen === 'arch');
        const lean = struct ? 0.17 : 0.05;
        const sc = struct ? 1.0 + r2 * 0.6 : 0.8 + r2 * 0.7;   // occasional taller stone vs modest props
        const yaw = r1 * Math.PI * 2;
        (buckets[chosen] ||= []).push([px, h - 0.06, pz, yaw, sc, (r2 - 0.5) * 2 * lean, (r3 - 0.5) * 2 * lean, 0.82 + r1 * 0.32]);
        const spec = COLLIDE[chosen];
        if (spec) {
          const geo = this.kitGeo[chosen];
          if (!geo.boundingBox) geo.computeBoundingBox();
          const localTop = geo.boundingBox?.max.y ?? Math.max(...spec.map(s => s.h || 0));
          const cs = Math.cos(yaw), sn = Math.sin(yaw);
          for (const s of spec) colliders.push({
            kind: chosen,
            x: px + (s.x * cs + s.z * sn) * sc,
            z: pz + (-s.x * sn + s.z * cs) * sc,
            r: s.r * sc,
            baseY: h - 0.06,
            scale: sc,
            localTop,
            topY: h - 0.06 + localTop * sc + 0.02,     // exact visible top + tiny numeric tolerance
          });
        }
      }
    }
    const group = new THREE.Group();
    const SOFT = { pine: 1, pine_dark: 1 };              // billow-normal foliage → smooth material
    for (const name in buckets) {
      const arr = buckets[name], mat = this.glowMats[name] || (SOFT[name] ? this.kitSoftMat : this.kitMat);
      const inst = new THREE.InstancedMesh(this.kitGeo[name], mat, arr.length);
      inst.castShadow = inst.receiveShadow = true;
      const tint = !this.glowMats[name];
      arr.forEach(([x, y, z, yaw, sc, tx, tz, br], k) => {
        this._e.set(tx, yaw, tz); this._q.setFromEuler(this._e); this._s.set(sc, sc, sc);
        this._m.compose(this._v.set(x, y, z), this._q, this._s);
        inst.setMatrixAt(k, this._m);
        if (tint) inst.setColorAt(k, this._c.setScalar(br));
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      group.add(inst);
    }
    group.userData.colliders = colliders;
    group.userData.instanceCount = Object.values(buckets).reduce((sum, arr) => sum + arr.length, 0);
    return group;
  }

  // circle push-out against prop colliders in the player's chunk neighbourhood.
  // Returns the resolved (x, z); callers assign it back to the mover's position.
  resolve(px, pz, pr = 0.35, clearanceY = -Infinity) {
    const cx = Math.floor(px / this.CHUNK), cz = Math.floor(pz / this.CHUNK);
    let x = px, z = pz;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const g = this.chunks.get((cx + i) + ',' + (cz + j));
      const cols = g && g.userData.colliders;
      if (!cols) continue;
      for (const c of cols) {
        if (clearanceY >= c.topY - 0.03) continue;       // current jump arc can genuinely clear the prop
        const dx = x - c.x, dz = z - c.z, rr = c.r + pr, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2);
          if (d < 0.001) { x += rr; continue; }          // dead-centre (teleport/spawn): push east
          x += dx / d * (rr - d); z += dz / d * (rr - d);
        }
      }
    }
    return { x, z };
  }

  debugCollider(kind) {
    for (const group of this.chunks.values()) {
      const found = group.userData.colliders?.find(c => c.kind === kind);
      if (found) return { ...found };
    }
    return null;
  }

  debugDensityAt(x, z = 0) {
    const b = biomeAt(x), cx = Math.floor(x / this.CHUNK), cz = Math.floor(z / this.CHUNK);
    const group = this.chunks.get(cx + ',' + cz);
    let nearestSpawnProp = Infinity;
    for (const chunk of this.chunks.values()) for (const c of chunk.userData.colliders || []) nearestSpawnProp = Math.min(nearestSpawnProp, Math.hypot(c.x, c.z) - c.r);
    return {
      biome: biomeNameAt(x), scatterDensity: b.scatterDensity,
      scatterCount: group?.userData.scatterCount ?? null,
      colliderCount: group?.userData.colliders?.length ?? null,
      nearestSpawnProp: Number.isFinite(nearestSpawnProp) ? nearestSpawnProp : null,
    };
  }

  _ensure(cx, cz) {
    const key = cx + ',' + cz;
    if (this.chunks.has(key)) return;
    const ox = cx * this.CHUNK, oz = cz * this.CHUNK;
    const g = new THREE.Group();
    const scatter = this._scatter(ox, oz);
    g.add(this._terrain(ox, oz)); g.add(scatter); g.add(this._grass(ox, oz));
    g.userData.colliders = scatter.userData.colliders;   // hoisted for resolve()'s chunk lookup
    g.userData.scatterCount = scatter.userData.instanceCount;
    this.scene.add(g); this.chunks.set(key, g);
  }
  _dispose(key) {
    const g = this.chunks.get(key); if (!g) return;
    this.scene.remove(g);
    // only the per-chunk terrain geometry is unique; kit/grass geometries are SHARED across
    // chunks (instanced) — disposing them would corrupt the still-loaded neighbours.
    g.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.geometry) o.geometry.dispose(); });
    this.chunks.delete(key);
  }
  update(px, pz) {
    const R = this.RADIUS, ccx = Math.round(px / this.CHUNK), ccz = Math.round(pz / this.CHUNK);
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) this._ensure(ccx + i, ccz + j);
    for (const key of [...this.chunks.keys()]) { const [x, z] = key.split(',').map(Number); if (Math.abs(x - ccx) > R + 1 || Math.abs(z - ccz) > R + 1) this._dispose(key); }
    this._streamLakes(px, pz);                                   // bounded water over real basins only
    const pix = innerHeight || 900;                              // refresh point-sprite scale (innerHeight can be 0 at construction)
    this.motesMat.uniforms.uPix.value = pix; this.rain.material.uniforms.uPix.value = pix; this.snow.material.uniforms.uPix.value = pix;
    const a = this.atmoAt(px);
    this.uniforms.uSky.value.copy(a.sky);                        // horizon colour (sky dome + water sheen)
    this.skyMat.uniforms.uZenith.value.copy(a.sky).multiplyScalar(0.4);
    this.skyMat.uniforms.uSunCol.value.copy(a.sun);
    this.sky.position.set(px, 0, pz);
    this.rays.position.set(px, this.heightAt(px, pz), pz);       // light shafts follow the player
    this.rays.rotation.y = this.uniforms.uTime.value * 0.02;
    this.rayMat.color.copy(a.sun);
    this.rayMat.opacity = Math.min(0.018, a.sunI * 0.007);       // supporting haze; screen-space shafts carry the focal light
    this.motes.position.set(px, this.heightAt(px, pz), pz);      // motes box follows the player
    this.motesMat.uniforms.uColor.value.copy(a.spark);
    const driftness = Math.max(0, Math.min(1, (px - 60) / 40));  // ramps up approaching the Drift centre (100)
    this.aurora.position.set(px, 34, pz - 24);
    this.auroraMat.uniforms.uOpacity.value = driftness * 0.9;
    const gy = this.heightAt(px, pz);
    if (this.rain.visible) this.rain.position.set(px, gy, pz);   // precip boxes follow the player
    if (this.snow.visible) this.snow.position.set(px, gy, pz);
  }
}
