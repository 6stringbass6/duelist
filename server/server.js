// =====================================================================
// GRIDSTRIKE — authoritative realtime server (Node + Socket.io + Supabase)
// env: PORT, CLIENT_ORIGIN(쉼표 구분), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// 좌표계: y-up, yaw=0 → -Z 방향. forward = (-sin(yaw)cos(p), sin(p), -cos(yaw)cos(p))
// =====================================================================
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';

try { process.loadEnvFile?.(); } catch { /* .env 없음 */ }

const PORT = +process.env.PORT || 3001;
const ORIGINS = (process.env.CLIENT_ORIGIN || '*').split(',').map((s) => s.trim());
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export const clock = { now: () => Date.now() };

// 개발자 인증 코드 — 서버 환경변수로만 보관(클라이언트에 노출 금지). 해시 후 상수시간 비교.
const DEV_SECRET = process.env.DEV_SECRET_CODE || '';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const isDevCode = (s) => !!DEV_SECRET && crypto.timingSafeEqual(sha256(s), sha256(DEV_SECRET));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────────── 1. 규칙 / 상수 ─────────────────────────────
export const RULES = {
  hp: 150, dummyHp: 150, tickHz: 30, snapMs: 50,
  roundsToWin: 5, buyMs: 8000, roundMs: 100000, roundEndMs: 4500, endMs: 12000,
  tdmWarmupMs: 5000, tdmTimeMs: 600000, tdmKillsPerPlayer: 10, tdmRespawnMs: 250, spawnProtectMs: 1500,
  loadoutWindowMs: 5000, rangeRespawnMs: 1500, assistWindowMs: 10000, maxRewindMs: 250, fireTolMs: 35,
};
export const MOVE = {
  run: 6.6, gravity: 22, jumpV: 7.6, slideV: 12.5, updraftV: 17, dashMult: 1.6, dashMs: 3000, skillCdMs: 7000,
  eye: 1.6, eyeCrouch: 1.0, radius: 0.4,
};
export const F = { CROUCH: 1, SLIDE: 2, ADS: 4, AIR: 8, DASH: 16, ALIVE: 32, PROT: 64, RELOAD: 128, FLASHED: 256, AMP: 512, SILENCED: 1024, SHIELD: 2048, HEAL: 4096, INVIS: 8192, CAST: 16384 };
const HB = { // 히트박스 (발 기준 높이)
  s: { headY: 1.62, headR: 0.23, bodyTop: 1.38, legTop: 0.72, bodyR: 0.36, legR: 0.28 },
  c: { headY: 1.02, headR: 0.23, bodyTop: 0.8, legTop: 0.4, bodyR: 0.38, legR: 0.34 },
};
// 슬롯 번호 = 숫자키: 1 주무기 / 2 보조 / 3 근접 / 4 투척 (client/src/config/weapons.ts SLOT_KEYS 와 동일)
const SLOT_KEYS = { 1: 'primary', 2: 'secondary', 3: 'melee', 4: 'throwable' };
const SLOT = { primary: 1, secondary: 2, melee: 3, throwable: 4 };
const DEFAULT_LOADOUT = { melee: 'dagger', secondary: 'classic', primary: 'vandal', throwable: 'grenade', q: 'updraft', e: 'haste', x: 'omen' };
// 스킬 정의 (client/src/config/skills.ts 와 동일 수치). cd=쿨타임(ms), uses=라운드(리스폰)당 사용 횟수
export const SKILLS = {
  updraft:  { cd: 7000, uses: 3 },
  haste:    { cd: 8000, uses: 2, ms: 5000 },
  amp:      { cd: 12000, uses: 2, ms: 5000, mult: 1.4 },
  suppress: { cd: 15000, uses: 2, radius: 12, silenceMs: 8000, speed: 20, lift: 3 },
  heal:     { cd: 18000, uses: 2, ms: 4000, total: 60 },
  barrier:  { cd: 14000, uses: 2, w: 6, h: 3.2, t: 0.6, hp: 250, range: 22, lifeMs: 30000, maxPerOwner: 3 },
  shield:   { cd: 20000, uses: 1, ms: 10000, orbMs: 15000 },
};
export const ULTS = { omen: { castMs: 1500 }, yoru: { ms: 7000, afterMs: 700 }, iso: { range: 40, width: 1.6, ms: 15000 } };
export const ULT_COST = 6;
const THROW_G = 20, PROJ_R = 0.12;

// ranges: [최대거리, head, body, leg] (발로란트 원본) × scale → 반올림
export const WEAPONS = {
  fists:   { slot: 3, type: 'melee', dmg: 25, intervalMs: 400, range: 1.9, arcDeg: 70, backMult: 1, move: 1.15, equipMs: 150 },
  dagger:  { slot: 3, type: 'melee', dmg: 35, intervalMs: 300, range: 2.1, arcDeg: 70, backMult: 2, move: 1.2, equipMs: 150 },
  sword:   { slot: 3, type: 'melee', dmg: 95, intervalMs: 1050, range: 2.7, arcDeg: 90, backMult: 1.6, move: 1.12, equipMs: 250 },
  classic: { slot: 2, type: 'gun', auto: false, rps: 6.75, mag: 12, reloadMs: 1750, scale: 1, ranges: [[30, 52, 22, 19], [Infinity, 46, 20, 17]],
             spread: { base: 0.25, perShot: 0.35, max: 2.2, recoverMs: 350 }, alt: { burst: 3, rps: 2.22, spread: 1.8 }, move: 1.06, equipMs: 300 },
  shorty:  { slot: 2, type: 'gun', auto: false, rps: 3.33, mag: 2, reloadMs: 1750, scale: 1, pellets: 12, ranges: [[7, 36, 12, 10], [15, 24, 8, 6], [Infinity, 9, 3, 2]],
             spread: { base: 4.2, perShot: 0, max: 4.2, recoverMs: 300 }, move: 1.06, equipMs: 300 },
  frenzy:  { slot: 2, type: 'gun', auto: true, rps: 10, mag: 13, reloadMs: 1500, scale: 1, ranges: [[20, 44, 20, 17], [Infinity, 40, 18, 15]],
             spread: { base: 0.45, perShot: 0.22, max: 2.6, recoverMs: 400 }, move: 1.06, equipMs: 300 },
  ghost:   { slot: 2, type: 'gun', auto: false, rps: 6.75, mag: 15, reloadMs: 1500, scale: 1, ranges: [[30, 56, 25, 21], [Infinity, 52, 23, 19]],
             spread: { base: 0.2, perShot: 0.3, max: 1.9, recoverMs: 350 }, move: 1.06, equipMs: 300 },
  sheriff: { slot: 2, type: 'gun', auto: false, rps: 4, mag: 6, reloadMs: 2250, scale: 1, ranges: [[30, 80, 38, 32], [Infinity, 76, 36, 30]],
             spread: { base: 0.15, perShot: 0.9, max: 2.5, recoverMs: 500 }, move: 1.06, equipMs: 350 },
  vandal:  { slot: 1, type: 'gun', auto: true, rps: 9.75, mag: 25, reloadMs: 2500, scale: 1, ranges: [[Infinity, 56, 28, 24]],
             spread: { base: 0.12, perShot: 0.14, max: 1.7, recoverMs: 380 }, adsSpread: 0.85, move: 1, equipMs: 400 },
  phantom: { slot: 1, type: 'gun', auto: true, rps: 11, mag: 30, reloadMs: 2500, scale: 1, ranges: [[Infinity, 52, 24, 20]],
             spread: { base: 0.1, perShot: 0.11, max: 1.4, recoverMs: 350 }, adsSpread: 0.85, move: 1, equipMs: 400 },
  marshal: { slot: 1, type: 'gun', auto: false, rps: 1.5, mag: 5, reloadMs: 2500, scale: 1, ranges: [[Infinity, 202, 101, 85]],
             spread: { base: 0, perShot: 0, max: 0, recoverMs: 300, hip: 6.5 }, zoom: 3.5, scopeMs: 150, move: 1, equipMs: 450 },
  grenade: { slot: 4, type: 'throw', fuseMs: 2000, speed: 21, lift: 3, radius: 6.5, maxDmg: 130, minDmg: 15, selfMult: 0.5, charges: 2, restitution: 0.45, move: 1.06 },
  flash:   { slot: 4, type: 'throw', fuseMs: 1600, altFuseMs: 1000, speed: 24, altSpeed: 10, lift: 2, altLift: 3.5, maxBlindMs: 2250, altMaxBlindMs: 1500, charges: 2, restitution: 0.5, move: 1.06 },
};
for (const w of Object.values(WEAPONS)) if (w.ranges) w.table = w.ranges.map(([d, h, b, l]) => [d, Math.round(h * w.scale), Math.round(b * w.scale), Math.round(l * w.scale)]);
const damageAt = (w, dist, zone) => { const r = w.table.find((x) => dist <= x[0]) || w.table[w.table.length - 1]; return zone === 'head' ? r[1] : zone === 'body' ? r[2] : r[3]; };

// ───────────────────────────── 2. 티어 / 봇 파라미터 ─────────────────────────────
// level 0..17 = Bronze I..Onyx III (200RP 단위), 18 = Nemesis(3600+), 19 = Archnemesis(Top 200)
export const TIER_NAMES = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Onyx'];
export const tierLevel = (rp, pos) => (rp >= 3600 ? (pos && pos <= 200 ? 19 : 18) : Math.floor(Math.max(0, rp) / 200));
export const tierLabel = (lv) => (lv >= 19 ? 'Archnemesis' : lv === 18 ? 'Nemesis' : `${TIER_NAMES[Math.floor(lv / 3)]} ${'I'.repeat((lv % 3) + 1)}`);
const levelRp = (lv) => (lv >= 19 ? 4200 : lv * 200 + 100);
//             반응ms  조준오차°  회전°/s  헤드조준  점사[min,max]  스트레이프  시야각°  기억ms  스킬   투척
const BOT_ANCHORS = [
  { react: 620, err: 7.0,  turn: 140, head: 0.05, b0: 2, b1: 4,  strafe: 0.15, fov: 95,  mem: 1500, skill: 0.0,  util: 0.0 },  // Bronze
  { react: 520, err: 5.4,  turn: 180, head: 0.10, b0: 2, b1: 5,  strafe: 0.30, fov: 100, mem: 2000, skill: 0.05, util: 0.05 }, // Silver
  { react: 430, err: 4.0,  turn: 230, head: 0.18, b0: 3, b1: 5,  strafe: 0.45, fov: 105, mem: 2500, skill: 0.12, util: 0.12 }, // Gold
  { react: 350, err: 3.0,  turn: 290, head: 0.27, b0: 3, b1: 6,  strafe: 0.60, fov: 110, mem: 3000, skill: 0.22, util: 0.20 }, // Platinum
  { react: 285, err: 2.2,  turn: 360, head: 0.37, b0: 3, b1: 6,  strafe: 0.72, fov: 115, mem: 3500, skill: 0.35, util: 0.30 }, // Diamond
  { react: 230, err: 1.55, turn: 440, head: 0.48, b0: 4, b1: 7,  strafe: 0.84, fov: 120, mem: 4000, skill: 0.50, util: 0.40 }, // Onyx
  { react: 185, err: 1.05, turn: 540, head: 0.60, b0: 4, b1: 8,  strafe: 0.93, fov: 125, mem: 5000, skill: 0.70, util: 0.50 }, // Nemesis
  { react: 150, err: 0.70, turn: 660, head: 0.72, b0: 5, b1: 9,  strafe: 1.00, fov: 130, mem: 6000, skill: 0.85, util: 0.60 }, // Archnemesis
];
export function botParams(level) {
  const f = level >= 19 ? 7 : level === 18 ? 6 : Math.floor(level / 3) + (level % 3) / 3;
  const a = BOT_ANCHORS[Math.floor(f)], b = BOT_ANCHORS[Math.min(7, Math.floor(f) + 1)], t = f - Math.floor(f), P = {};
  for (const k of Object.keys(a)) P[k] = a[k] + (b[k] - a[k]) * t;
  P.burst = [Math.round(P.b0), Math.round(P.b1)]; P.level = level;
  return P;
}
const BOT_NAMES = ['Vex', 'Nyx', 'Kairo', 'Zed', 'Lumen', 'Echo', 'Riven', 'Tako', 'Miso', 'Pixel', 'Jolt', 'Hex', 'Nova', 'Blitz', 'Mochi', 'Rune', 'Flux', 'Ember', 'Dusk', 'Kite', 'Byte', 'Sora', 'Quill', 'Onda'];

// ───────────────────────────── 3. 수학 / 레이캐스트 ─────────────────────────────
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const angDiff = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
const dirFrom = (yaw, pitch) => { const cp = Math.cos(pitch); return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp }; };
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const eyeOf = (e) => ({ x: e.pos.x, y: e.pos.y + (e.flags & 3 ? MOVE.eyeCrouch : MOVE.eye), z: e.pos.z });

function spreadDir(d, deg) {
  if (deg <= 0) return d;
  const th = deg * DEG * Math.sqrt(Math.random()), ph = Math.random() * 2 * Math.PI;
  const up = Math.abs(d.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let rx = d.y * up.z - d.z * up.y, ry = d.z * up.x - d.x * up.z, rz = d.x * up.y - d.y * up.x;
  const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * d.z - rz * d.y, uy = rz * d.x - rx * d.z, uz = rx * d.y - ry * d.x;
  const s = Math.sin(th), c = Math.cos(th), cp = Math.cos(ph) * s, sp = Math.sin(ph) * s;
  return { x: d.x * c + rx * cp + ux * sp, y: d.y * c + ry * cp + uy * sp, z: d.z * c + rz * cp + uz * sp };
}
function rayBox(o, d, b, maxT) { // b=[x0,y0,z0,x1,y1,z1]
  let t0 = 0, t1 = maxT, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const oi = i === 0 ? o.x : i === 1 ? o.y : o.z, di = i === 0 ? d.x : i === 1 ? d.y : d.z, mn = b[i], mx = b[i + 3];
    if (Math.abs(di) < 1e-9) { if (oi < mn || oi > mx) return null; continue; }
    let ta = (mn - oi) / di, tb = (mx - oi) / di, s = -1;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
    if (ta > t0) { t0 = ta; axis = i; sign = s; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  return axis < 0 ? null : { t: t0, axis, sign };
}
function raycastWorld(map, o, d, maxT) {
  let best = null, bt = maxT;
  if (d.y < -1e-9) { const t = -o.y / d.y; if (t >= 0 && t < bt) { bt = t; best = { t, axis: 1, sign: 1 }; } }
  const boxes = map.boxes;
  for (let i = 0; i < boxes.length; i++) { const h = rayBox(o, d, boxes[i], bt); if (h && h.t < bt) { bt = h.t; best = h; h.box = boxes[i]; } }
  return best;
}
function losClear(map, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return true;
  return !raycastWorld(map, a, { x: dx / len, y: dy / len, z: dz / len }, len - 0.05);
}
function raySphere(o, d, cx, cy, cz, r) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz, b = ox * d.x + oy * d.y + oz * d.z, c = ox * ox + oy * oy + oz * oz - r * r, disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}
function rayCyl(o, d, cx, cz, y0, y1, r) {
  const ox = o.x - cx, oz = o.z - cz, a = d.x * d.x + d.z * d.z; let best = Infinity;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z, c = ox * ox + oz * oz - r * r, disc = b * b - a * c;
    if (disc >= 0) { const t = (-b - Math.sqrt(disc)) / a; if (t >= 0) { const y = o.y + d.y * t; if (y >= y0 && y <= y1) best = t; } }
  }
  if (Math.abs(d.y) > 1e-9) {
    const t = ((d.y < 0 ? y1 : y0) - o.y) / d.y;
    if (t >= 0 && t < best) { const x = ox + d.x * t, z = oz + d.z * t; if (x * x + z * z <= r * r) best = t; }
  }
  return best;
}
function rayEntity(o, d, p, crouched, maxT) {
  const hb = crouched ? HB.c : HB.s; let best = maxT, zone = null;
  let t = raySphere(o, d, p.x, p.y + hb.headY, p.z, hb.headR); if (t < best) { best = t; zone = 'head'; }
  t = rayCyl(o, d, p.x, p.z, p.y + hb.legTop, p.y + hb.bodyTop, hb.bodyR); if (t < best) { best = t; zone = 'body'; }
  t = rayCyl(o, d, p.x, p.z, p.y, p.y + hb.legTop, hb.legR); if (t < best) { best = t; zone = 'leg'; }
  return zone ? { t: best, zone } : null;
}
function insideSolid(map, x, y, z) {
  for (const b of map.boxes) if (x > b[0] + 0.2 && x < b[3] - 0.2 && y > b[1] + 0.2 && y < b[4] - 0.2 && z > b[2] + 0.2 && z < b[5] - 0.2) return true;
  return false;
}

// ───────────────────────────── 4. 내비게이션 (그리드 A*) ─────────────────────────────
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
  pop() { const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length; if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; } return top; }
}
function buildNav(bounds, boxes) {
  const cs = 1, r = 0.45, w = Math.ceil((bounds.x1 - bounds.x0) / cs), h = Math.ceil((bounds.z1 - bounds.z0) / cs), grid = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const cx = bounds.x0 + (i + 0.5) * cs, cz = bounds.z0 + (j + 0.5) * cs;
    if (cx - r < bounds.x0 || cx + r > bounds.x1 || cz - r < bounds.z0 || cz + r > bounds.z1) { grid[j * w + i] = 1; continue; }
    for (const b of boxes) if (b[1] < 1.7 && b[4] > 0.05 && cx > b[0] - r && cx < b[3] + r && cz > b[2] - r && cz < b[5] + r) { grid[j * w + i] = 1; break; }
  }
  return { cs, x0: bounds.x0, z0: bounds.z0, w, h, grid, g: new Float32Array(w * h), from: new Int32Array(w * h), mark: new Uint32Array(w * h), stamp: 0 };
}
const cellOf = (nav, x, z) => { const i = Math.floor((x - nav.x0) / nav.cs), j = Math.floor((z - nav.z0) / nav.cs); return i < 0 || j < 0 || i >= nav.w || j >= nav.h ? -1 : j * nav.w + i; };
const cellCenter = (nav, c) => ({ x: nav.x0 + ((c % nav.w) + 0.5) * nav.cs, z: nav.z0 + (((c / nav.w) | 0) + 0.5) * nav.cs });
const navFree = (nav, x, z) => { const c = cellOf(nav, x, z); return c >= 0 && !nav.grid[c]; };
function nearestFree(nav, x, z) {
  const ci = clamp(Math.floor((x - nav.x0) / nav.cs), 0, nav.w - 1), cj = clamp(Math.floor((z - nav.z0) / nav.cs), 0, nav.h - 1);
  for (let r = 0; r <= 8; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
    const i = ci + di, j = cj + dj;
    if (i >= 0 && j >= 0 && i < nav.w && j < nav.h && !nav.grid[j * nav.w + i]) return j * nav.w + i;
  }
  return -1;
}
function lineFree(nav, x0, z0, x1, z1) {
  const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / 0.5);
  for (let i = 1; i <= n; i++) { const t = i / n; if (!navFree(nav, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
  return true;
}
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];
function findPath(nav, sx, sz, gx, gz) {
  const s = nearestFree(nav, sx, sz), g = nearestFree(nav, gx, gz);
  if (s < 0 || g < 0) return null;
  if (s === g) return [cellCenter(nav, g)];
  const { w, h, grid, g: gS, from, mark } = nav, stamp = ++nav.stamp, gi = g % w, gj = (g / w) | 0;
  const H = (i) => { const dx = Math.abs((i % w) - gi), dz = Math.abs(((i / w) | 0) - gj); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
  const heap = new Heap(); gS[s] = 0; mark[s] = stamp; from[s] = -1; heap.push(H(s), s);
  let iter = 0;
  while (heap.size && iter++ < 20000) {
    const c = heap.pop(); if (c === g) break;
    const cx = c % w, cz = (c / w) | 0, gc = gS[c];
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX[d], nz = cz + DZ[d];
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const n = nz * w + nx; if (grid[n]) continue;
      if (d >= 4 && (grid[cz * w + nx] || grid[nz * w + cx])) continue;
      const ng = gc + (d >= 4 ? 1.4142 : 1);
      if (mark[n] === stamp && gS[n] <= ng) continue;
      gS[n] = ng; mark[n] = stamp; from[n] = c; heap.push(ng + H(n), n);
    }
  }
  if (mark[g] !== stamp) return null;
  const out = []; for (let c = g; c !== -1; c = from[c]) out.push(cellCenter(nav, c));
  return out.reverse();
}

// ───────────────────────────── 5. 맵 (서버가 지오메트리의 단일 원본 → 클라에 전송) ─────────────────────────────
const B = (cx, cz, w, d, h, y = 0, kind = 'block') => [cx - w / 2, y, cz - d / 2, cx + w / 2, y + h, cz + d / 2, kind];
const sym = (list) => list.flatMap((b) => [b, [-b[3], b[1], -b[5], -b[0], b[4], -b[2], b[6]]]); // 원점 대칭
const overlaps = (a, b, m = 0) => a[0] < b[3] + m && a[3] > b[0] - m && a[2] < b[5] + m && a[5] > b[2] - m;
function mkMap(id, name, bounds, wallH, boxes, spawns, extra = {}) {
  const { x0, x1, z0, z1 } = bounds, T = 2;
  const all = [...boxes,
    [x0 - T, 0, z0 - T, x0, wallH, z1 + T, 'bound'], [x1, 0, z0 - T, x1 + T, wallH, z1 + T, 'bound'],
    [x0, 0, z0 - T, x1, wallH, z0, 'bound'], [x0, 0, z1, x1, wallH, z1 + T, 'bound']];
  const nav = buildNav(bounds, all);
  let duel = null;
  if (id !== 'range') { // 아이소 궁극기: 맵 외곽(동쪽)의 1:1 격리 아레나 (높은 벽으로 완전 밀폐)
    const dx0 = x1 + 30, dx1 = dx0 + 26, dz0 = -13, dz1 = 13, H = 18;
    all.push([dx0, -0.5, dz0, dx1, 0, dz1, 'duelfloor'],
      [dx0 - 2, 0, dz0 - 2, dx0, H, dz1 + 2, 'duel'], [dx1, 0, dz0 - 2, dx1 + 2, H, dz1 + 2, 'duel'],
      [dx0, 0, dz0 - 2, dx1, H, dz0, 'duel'], [dx0, 0, dz1, dx1, H, dz1 + 2, 'duel'],
      [(dx0 + dx1) / 2 - 1.5, 0, -1.5, (dx0 + dx1) / 2 + 1.5, 2.4, 1.5, 'cover']);
    duel = { rect: { x0: dx0, x1: dx1, z0: dz0, z1: dz1 }, spawns: [{ x: dx0 + 3, y: 0, z: 0, yaw: -Math.PI / 2 }, { x: dx1 - 3, y: 0, z: 0, yaw: Math.PI / 2 }] };
  }
  return { id, name, bounds, wallH, boxes: all, spawns, nav, duel, ...extra };
}
const mkSpawns = (z, xs, yaw) => xs.map((x) => ({ x, y: 0, z, yaw }));
function buildGrid() {
  const boxes = [
    B(0, 0, 14, 14, 1.0, 0, 'platform'), B(0, 0, 4, 4, 4, 1.0, 'pillar'),
    ...sym([
      B(0, -44, 24, 1.5, 3.5, 0, 'wall'),                                  // 스폰 차폐벽: 스폰열(x±10)보다 넓게 → 시작 시 상호 시야 차단, 좌우(|x|>12)로 우회
      B(-9, -34, 10, 1.2, 1.4, 0, 'cover'), B(9, -34, 10, 1.2, 1.4, 0, 'cover'),
      B(-16, -10, 3, 3, 3), B(-24, 4, 3, 3, 3), B(16, -18, 3, 3, 3),
      B(-10, -22, 6, 2, 2.2, 0, 'wall'), B(-30, -14, 2, 8, 3.2, 0, 'wall'), B(28, -26, 8, 2, 3.2, 0, 'wall'),
      B(-38, -30, 6, 6, 6, 0, 'tower'), B(-33.5, -30, 3, 3, 3, 0, 'step'), B(-31, -30, 2, 3, 1.5, 0, 'step'),
      B(40, -8, 6, 6, 6, 0, 'tower'), B(40, -12.5, 3, 3, 3, 0, 'step'),
      B(-48, 0, 4, 12, 2.5, 0, 'platform'),
    ]),
  ];
  for (let gx = -45; gx <= 45; gx += 15) for (let gz = -45; gz <= 45; gz += 15) { // 그리드 기둥
    if (Math.abs(gx) < 12 && Math.abs(gz) < 12) continue;
    const p = B(gx, gz, 1.5, 1.5, 5, 0, 'pillar');
    if (!boxes.some((b) => overlaps(p, b, 1.5))) boxes.push(p);
  }
  const xs = [-10, -6, -2, 2, 6, 10];
  return mkMap('grid', 'GRID', { x0: -60, x1: 60, z0: -60, z1: 60 }, 12, boxes, [mkSpawns(-52, xs, Math.PI), mkSpawns(52, xs, 0)]);
}
function buildArena() {
  const boxes = [
    B(0, 0, 4, 4, 3.2, 0, 'block'),
    ...sym([
      B(0, -15.5, 21, 1.2, 3.2, 0, 'wall'),                                // 스폰 차폐벽: 스폰열(x±9) 전체를 가림 → 시작 시 상호 시야 차단, 좌우(|x|>10.5)로 우회
      B(-8, -4, 1.2, 8, 3.2, 0, 'wall'), B(-13, 5, 5, 1.2, 3.2, 0, 'wall'),
      B(-6, -10.5, 4, 1.2, 1.3, 0, 'cover'), B(6, -10.5, 4, 1.2, 1.3, 0, 'cover'),
      B(-17, -9, 4, 4, 1.6, 0, 'crate'), B(-17.5, -13.5, 3, 3, 3.2, 0, 'crate'), B(13, -6, 2.5, 2.5, 2.5, 0, 'crate'),
      B(-19.5, 0, 5, 10, 2.0, 0, 'ledge'), B(-19.5, -6.5, 5, 3, 1.0, 0, 'step'),
    ]),
  ];
  const xs = [-9, -6, -3, 3, 6, 9];
  return mkMap('arena', 'ARENA', { x0: -22, x1: 22, z0: -22, z1: 22 }, 8, boxes, [mkSpawns(-19.5, xs, Math.PI), mkSpawns(19.5, xs, 0)]);
}
function buildRange() {
  const marks = [5, 10, 20, 30, 50, 70, 100, 150], xs = [-3, 3, -5, 5, 0, -4, 4, 0];
  const boxes = [B(-9, 1.2, 8, 0.6, 1.0, 0, 'cover'), B(9, 1.2, 8, 0.6, 1.0, 0, 'cover')];
  return mkMap('range', 'THE RANGE', { x0: -15, x1: 15, z0: -160, z1: 8 }, 8, boxes, [[{ x: 0, y: 0, z: 3, yaw: 0 }], []],
    { marks: marks.map((m) => ({ z: -m + 3, label: `${m}m` })), dummies: marks.map((m, i) => ({ x: xs[i], y: 0, z: -m + 3, yaw: Math.PI })) });
}
export const MAPS = { grid: buildGrid(), arena: buildArena(), range: buildRange() };
const mapPublic = (m) => ({ id: m.id, name: m.name, bounds: m.bounds, wallH: m.wallH, boxes: m.boxes, spawns: m.spawns, marks: m.marks || [], duel: m.duel || null });

// ───────────────────────────── 6. 방 / 엔티티 ─────────────────────────────
let io = null, roomSeq = 0;
export const rooms = new Map();
const codes = new Map();
const online = new Map(); // userId → socket
let titleCache = new Map(), titleCacheAt = 0;

const emitRoom = (room, ev, data) => io.to(room.id).emit(ev, data);
const emitTo = (e, ev, data) => { if (e.sess) e.sess.socket.emit(ev, data); };
const teamEnts = (room, t) => [...room.ents.values()].filter((e) => e.team === t);
const humans = (room) => [...room.ents.values()].filter((e) => !e.isBot);
const isRound = (room) => room.mode === 'classic' || room.mode === 'ranked';
const newStats = () => ({ k: 0, d: 0, a: 0, hsk: 0, hh: 0, hb: 0, hl: 0, shots: 0, dmg: 0, melee: 0, nade: 0 });
const sanitizeName = (s) => (typeof s === 'string' ? s.replace(/[^A-Za-z0-9가-힣_]/g, '').slice(0, 16) : '');
function sanitizeLoadout(l) {
  const out = { ...DEFAULT_LOADOUT };
  if (l && typeof l === 'object') {
    for (const [slot, key] of Object.entries(SLOT_KEYS)) { const w = WEAPONS[l[key]]; if (w && w.slot === +slot) out[key] = l[key]; }
    if (typeof l.q === 'string' && Object.hasOwn(SKILLS, l.q)) out.q = l.q;
    if (typeof l.e === 'string' && Object.hasOwn(SKILLS, l.e)) out.e = l.e;
    if (typeof l.x === 'string' && Object.hasOwn(ULTS, l.x)) out.x = l.x;
  }
  if (out.q === out.e) out.e = Object.keys(SKILLS).find((k) => k !== out.q); // 같은 스킬 중복 장착 불가
  return out;
}

// 방마다 박스 배열을 복사 → 장벽(동적 충돌체)을 방 단위로 추가/제거
const roomMap = (m) => ({ ...m, boxes: [...m.boxes] });
function createRoom({ mode, teamSize, mapId, isPrivate = false, fillBots = true, botLevel = 6 }) {
  const room = {
    id: 'r' + (++roomSeq).toString(36), code: null, mode, teamSize, mapId, map: roomMap(MAPS[mapId]), isPrivate, fillBots, botLevel,
    hostId: 0, phase: 'lobby', endsAt: 0, round: 0, score: [0, 0], ents: new Map(), projs: new Map(), nextId: 1, nextProj: 1,
    lastSnap: 0, rangeMoving: false, walls: new Map(), orbs: new Map(), duels: [], nextWall: 1, nextOrb: 1,
  };
  if (isPrivate && mode !== 'range') { do { room.code = String(randInt(1000, 9999)); } while (codes.has(room.code)); codes.set(room.code, room); }
  rooms.set(room.id, room);
  return room;
}
function destroyRoom(room) {
  for (const e of humans(room)) if (e.sess) { e.sess.socket.leave(room.id); e.sess.room = null; e.sess.ent = null; }
  rooms.delete(room.id); if (room.code) codes.delete(room.code);
}
function newEntity(room, base) {
  const e = {
    id: room.nextId++, isBot: false, sess: null, userId: null, name: '', rp: 0, level: 0, title: null, skins: {}, career: { kd: 0, hs: 0, wr: 0 },
    team: 0, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, flags: 0, hp: 0, alive: false,
    loadout: { ...DEFAULT_LOADOUT }, pending: null, slot: SLOT.primary, ammo: { secondary: 0, primary: 0 }, charges: 0,
    reloadUntil: 0, reloadKey: null, nextFireAt: 0, nextThrowAt: 0, spray: 0, heat: 0, lastShotAt: 0, adsSince: 0,
    skillAt: { q: 0, e: 0 }, uses: {}, silencedUntil: 0, ampUntil: 0, healUntil: 0, healAcc: 0, shieldBuffUntil: 0, shield: 0, driftUntil: 0, cast: null, ult: 0, duel: null, dashUntil: 0, protUntil: 0, respawnAt: 0, spawnedAt: 0, spawnSeq: 0, flashedUntil: 0,
    lastMoveAt: 0, violations: 0, hist: [], dmgLog: new Map(), stats: newStats(), persisted: false, ai: null, ...base,
  };
  room.ents.set(e.id, e);
  return e;
}
const pub = (e) => ({ id: e.id, name: e.name, bot: e.isBot, team: e.team, tier: e.level, rp: e.rp, title: e.title, skins: e.skins, loadout: e.loadout, career: e.career, k: e.stats.k, d: e.stats.d, a: e.stats.a, dummy: !!e.ai?.dummy });
const roomState = (room) => ({
  id: room.id, code: room.code, mode: room.mode, teamSize: room.teamSize, mapId: room.mapId, isPrivate: room.isPrivate, hostId: room.hostId,
  phase: room.phase, endsAt: room.endsAt, round: room.round, score: room.score, fillBots: room.fillBots, botLevel: room.botLevel,
  target: room.mode === 'tdm' ? room.teamSize * RULES.tdmKillsPerPlayer : RULES.roundsToWin, players: [...room.ents.values()].map(pub),
});
const emitPhase = (room, extra = {}) => emitRoom(room, 'phase', { phase: room.phase, endsAt: room.endsAt, round: room.round, score: room.score, ...extra });
function emitAmmo(e) { emitTo(e, 'ammo', { s: e.ammo.secondary, p: e.ammo.primary, c: e.charges, r: e.reloadUntil, rk: e.reloadKey }); }

function refill(e) {
  e.ammo.secondary = WEAPONS[e.loadout.secondary].mag; e.ammo.primary = WEAPONS[e.loadout.primary].mag;
  e.charges = WEAPONS[e.loadout.throwable].charges; e.reloadUntil = 0; e.reloadKey = null;
}
function spawnEntity(room, e, pt, now) {
  if (e.pending) { e.loadout = e.pending; e.pending = null; emitRoom(room, 'loadout', { id: e.id, l: e.loadout }); }
  e.pos = { x: pt.x, y: pt.y, z: pt.z }; e.vel = { x: 0, y: 0, z: 0 }; e.yaw = pt.yaw; e.pitch = 0; e.flags = 0;
  e.hp = e.ai?.dummy ? RULES.dummyHp : RULES.hp; e.alive = true; e.slot = SLOT.primary; refill(e);
  e.spray = 0; e.heat = 0; e.nextFireAt = now; e.nextThrowAt = now; e.dashUntil = 0; e.flashedUntil = 0; e.respawnAt = 0;
  e.skillAt = { q: 0, e: 0 }; e.uses = {}; e.silencedUntil = e.ampUntil = e.healUntil = e.shieldBuffUntil = e.driftUntil = 0; e.shield = 0; e.cast = null; e.duel = null;
  e.protUntil = room.mode === 'tdm' ? now + RULES.spawnProtectMs : 0;
  e.spawnedAt = now; e.spawnSeq++; e.lastMoveAt = now; e.violations = 0; e.hist = []; e.dmgLog.clear();
  if (e.isBot) resetAi(e, now);
  emitAmmo(e);
  return [e.id, r2(pt.x), r2(pt.y), r2(pt.z), r3(pt.yaw), e.spawnSeq];
}
function pickSpawn(room, e) {
  const pts = room.map.spawns[e.team]; if (!pts.length) return e.ai?.home || { x: 0, y: 0, z: 0, yaw: 0 };
  const enemies = [...room.ents.values()].filter((o) => o.alive && o.team !== e.team);
  const mates = teamEnts(room, e.team).filter((o) => o.alive && o !== e);
  let best = pts[0], bs = -Infinity;
  for (const p of pts) {
    let s = Math.random() * 3;
    for (const en of enemies) s += Math.min(30, dist2(p, en.pos)) * 0.2;
    for (const m of mates) if (dist2(p, m.pos) < 1.5) s -= 100;
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}

// ───────────────────────────── 7. 봇 ─────────────────────────────
function resetAi(b, now) {
  const old = b.ai || {};
  b.ai = {
    P: old.P, dummy: old.dummy, home: old.home, state: 'patrol', target: null, lastSeen: null, lastSeenAt: 0, seenSince: 0, react: 0,
    path: null, pi: 0, repathAt: 0, errX: 0, errY: 0, errTx: 0, errTy: 0, errAt: 0, settle: 1, aimHead: false,
    burst: 0, pauseUntil: 0, clickAt: 0, strafe: 0, strafeUntil: 0, thinkAt: now + rand(100), utilAt: now + rand(4000, 10000), vy: 0, ph: rand(6.28),
  };
}
function addBot(room, team, now, level = room.botLevel) {
  const lv = clamp(level + randInt(-1, 1), 0, 19), used = new Set([...room.ents.values()].map((e) => e.name));
  const name = pick(BOT_NAMES.filter((n) => !used.has(n))) || 'Bot' + room.nextId;
  const b = newEntity(room, {
    isBot: true, name, team, level: lv, rp: levelRp(lv),
    loadout: {
      melee: pick(['dagger', 'sword']), secondary: pick(['classic', 'shorty', 'frenzy', 'ghost', 'sheriff']),
      primary: pick(lv >= 9 ? ['vandal', 'vandal', 'phantom', 'phantom', 'marshal'] : ['vandal', 'phantom', 'phantom']),
      throwable: pick(['grenade', 'flash']),
    },
  });
  b.ai = { P: botParams(lv) }; resetAi(b, now);
  return b;
}
function fillBots(room, now) { for (const t of [0, 1]) while (teamEnts(room, t).length < room.teamSize) addBot(room, t, now); }

function canSee(room, b, t, P) {
  const eye = eyeOf(b), dx = t.pos.x - eye.x, dz = t.pos.z - eye.z, d = Math.hypot(dx, dz);
  if (d > 140) return false;
  if (d > 5 && Math.abs(angDiff(Math.atan2(-dx, -dz), b.yaw)) > (P.fov * DEG) / 2) return false;
  const cr = t.flags & 3;
  return losClear(room.map, eye, { x: t.pos.x, y: t.pos.y + (cr ? 0.95 : 1.55), z: t.pos.z }) || losClear(room.map, eye, { x: t.pos.x, y: t.pos.y + 0.6, z: t.pos.z });
}
function patrolGoal(room, b) {
  const en = [...room.ents.values()].filter((o) => o.alive && o.team !== b.team);
  if (en.length) { const t = pick(en); return { x: t.pos.x + rand(-8, 8), z: t.pos.z + rand(-8, 8) }; }
  const bd = room.map.bounds; return { x: rand(bd.x0 + 3, bd.x1 - 3), z: rand(bd.z0 + 3, bd.z1 - 3) };
}
function tryMove(nav, b, dx, dz) {
  const nx = b.pos.x + dx, nz = b.pos.z + dz;
  if (navFree(nav, nx, nz)) { b.pos.x = nx; b.pos.z = nz; return true; }
  if (navFree(nav, nx, b.pos.z)) { b.pos.x = nx; return true; }
  if (navFree(nav, b.pos.x, nz)) { b.pos.z = nz; return true; }
  return false;
}
function botThink(room, b, now) {
  const ai = b.ai, P = ai.P; ai.thinkAt = now + 100;
  if (now < b.flashedUntil) { ai.state = 'blind'; ai.target = null; return; }
  if (ai.state === 'blind') ai.state = ai.lastSeen ? 'chase' : 'patrol';
  let best = null, bd = Infinity;
  for (const t of room.ents.values()) {
    if (!t.alive || t.team === b.team || !canSee(room, b, t, P)) continue;
    let d = dist3(b.pos, t.pos); if (t === ai.target) d *= 0.7;
    if (d < bd) { bd = d; best = t; }
  }
  if (best) {
    if (ai.target !== best || ai.state !== 'engage') {
      ai.seenSince = now; ai.react = P.react * (ai.state === 'chase' ? 0.75 : 1) * rand(0.85, 1.25);
      ai.settle = 2.5; ai.aimHead = Math.random() < P.head; ai.errAt = 0;
    }
    ai.target = best; ai.state = 'engage'; ai.lastSeen = { x: best.pos.x, y: best.pos.y, z: best.pos.z }; ai.lastSeenAt = now; ai.path = null;
  } else if (ai.state === 'engage') { ai.state = 'chase'; ai.target = null; ai.path = null; ai.repathAt = 0; }
  else if (ai.state === 'chase' && (!ai.lastSeen || now - ai.lastSeenAt > P.mem || dist2(b.pos, ai.lastSeen) < 2)) { ai.state = 'patrol'; ai.lastSeen = null; ai.path = null; ai.repathAt = 0; }

  // 무기 관리
  if (!b.reloadUntil) {
    if (b.slot !== SLOT.primary && ai.state !== 'engage') { b.slot = SLOT.primary; b.nextFireAt = now + 300; }
    const key = SLOT_KEYS[b.slot], w = WEAPONS[b.loadout[key]];
    if (b.ammo[key] <= 0) {
      if (b.slot === SLOT.primary && ai.state === 'engage' && bd < 14 && b.ammo.secondary > 0 && P.skill > 0.25) { b.slot = SLOT.secondary; b.nextFireAt = now + 300; }
      else startReload(room, b, now);
    } else if (ai.state !== 'engage' && b.ammo[key] < w.mag * 0.4) startReload(room, b, now);
  }
  // 투척 (추격 중 마지막 목격 지점으로)
  if (ai.state === 'chase' && ai.lastSeen && now >= ai.utilAt && b.charges > 0 && now - ai.lastSeenAt < 2500 && Math.random() < P.util) {
    const d = dist2(b.pos, ai.lastSeen);
    if (d > 8 && d < 32) {
      const wid = b.loadout.throwable, w = WEAPONS[wid], alt = wid === 'flash' && d < 12, sp = alt ? w.altSpeed : w.speed;
      b.yaw = Math.atan2(-(ai.lastSeen.x - b.pos.x), -(ai.lastSeen.z - b.pos.z));
      b.pitch = 0.5 * Math.asin(clamp((THROW_G * d) / (sp * sp), 0, 1)) * 0.8;
      throwProj(room, b, wid, { alt }, now); ai.utilAt = now + rand(6000, 14000);
    }
  }
  // 스킬: 가속(E) / 상승기류(Q)
  if (ai.state !== 'engage' && ai.path && ai.path.length - ai.pi > 15 && now >= b.skillAt.e && Math.random() < P.skill * 0.08) useSkill(room, b, 'e', now);
  if (ai.state === 'engage' && bd < 25 && b.pos.y <= 0 && now >= b.skillAt.q && Math.random() < P.skill * 0.02) { useSkill(room, b, 'q', now); ai.vy = MOVE.updraftV; }
}
function botFire(room, b, now, dist) {
  const ai = b.ai, key = SLOT_KEYS[b.slot], wid = b.loadout[key], w = WEAPONS[wid];
  if ((b.slot !== SLOT.secondary && b.slot !== SLOT.primary) || b.reloadUntil || b.ammo[key] <= 0 || now < b.nextFireAt) return;
  if (wid === 'shorty' && dist > 9) return;
  if (w.auto) {
    if (ai.burst <= 0) { if (now < ai.pauseUntil) return; ai.burst = randInt(ai.P.burst[0], ai.P.burst[1]) * (dist > 25 ? 1 : 2); }
    fireGun(room, b, w, wid, {}, now);
    if (--ai.burst <= 0) ai.pauseUntil = now + rand(120, 420);
  } else {
    if (now < ai.clickAt) return;
    fireGun(room, b, w, wid, {}, now);
    ai.clickAt = now + 1000 / w.rps + rand(0, 240 * (1.2 - ai.P.skill));
  }
}
function botAct(room, b, now, dt) {
  const ai = b.ai, P = ai.P, nav = room.map.nav, px = b.pos.x, pz = b.pos.z;
  if (ai.dummy) { // 사격장 훈련 봇
    if (room.rangeMoving) b.pos.x = clamp(ai.home.x + Math.sin(now / 700 + ai.ph) * 3, room.map.bounds.x0 + 1, room.map.bounds.x1 - 1);
    else b.pos.x = ai.home.x;
    b.vel.x = (b.pos.x - px) / dt; return;
  }
  if (b.pos.y > 0 || ai.vy > 0) { // 수직 물리 (상승기류)
    ai.vy -= MOVE.gravity * dt; b.pos.y += ai.vy * dt;
    if (b.pos.y <= 0) { b.pos.y = 0; ai.vy = 0; b.flags &= ~F.AIR; } else b.flags |= F.AIR;
  }
  const speed = MOVE.run * (WEAPONS[b.loadout[SLOT_KEYS[b.slot]]].move || 1) * (now < b.dashUntil ? MOVE.dashMult : 1);
  let wantYaw = b.yaw, wantPitch = 0, mx = 0, mz = 0, fire = false, tDist = 0, sp = speed;
  const t = ai.target;
  if (ai.state === 'engage' && t && t.alive) {
    const eye = eyeOf(b), cr = t.flags & 3, ty = t.pos.y + (ai.aimHead ? (cr ? HB.c.headY : HB.s.headY) : cr ? 0.6 : 1.05);
    const dx = t.pos.x - eye.x, dy = ty - eye.y, dz = t.pos.z - eye.z, hd = Math.hypot(dx, dz) || 1e-3; tDist = hd;
    if (now >= ai.errAt) { // 조준 오차 재샘플 (목표 이동 속도 ↑ → 오차 ↑, 최초 포착 시 플릭 오차)
      const s = P.err * (1 + Math.hypot(t.vel.x, t.vel.z) / 10) * ai.settle;
      ai.errTx = gauss() * s; ai.errTy = gauss() * s * 0.6; ai.errAt = now + rand(180, 380); ai.settle = Math.max(1, ai.settle * 0.7);
    }
    const k = Math.min(1, dt * 8); ai.errX += (ai.errTx - ai.errX) * k; ai.errY += (ai.errTy - ai.errY) * k;
    wantYaw = Math.atan2(-dx, -dz) + ai.errX * DEG; wantPitch = Math.atan2(dy, hd) + ai.errY * DEG;
    const fx = dx / hd, fz = dz / hd, wid = b.loadout[SLOT_KEYS[b.slot]];
    const pref = wid === 'shorty' ? [0, 6] : wid === 'marshal' ? [22, 70] : [7, 28];
    let f = hd > pref[1] ? 1 : hd < pref[0] && P.strafe > 0.3 ? -1 : 0;
    if (b.reloadUntil && P.strafe > 0.4) f = -1; // 재장전 중 후퇴
    if (now >= ai.strafeUntil) { ai.strafe = Math.random() < P.strafe ? (Math.random() < 0.5 ? -1 : 1) : 0; ai.strafeUntil = now + rand(300, 900); }
    mx = fx * f - fz * ai.strafe; mz = fz * f + fx * ai.strafe; sp = speed * 0.85;
    if (wid === 'marshal') { if (!(b.flags & F.ADS)) { b.flags |= F.ADS; b.adsSince = now; } } else b.flags &= ~F.ADS;
    fire = true;
  } else if (ai.state === 'blind') {
    if (now >= ai.strafeUntil) { ai.strafe = Math.random() < 0.5 ? -1 : 1; ai.strafeUntil = now + rand(300, 700); }
    mx = Math.cos(b.yaw) * ai.strafe; mz = -Math.sin(b.yaw) * ai.strafe; sp = speed * 0.5; wantYaw = b.yaw + Math.sin(now / 200) * 0.02; b.flags &= ~F.ADS;
  } else {
    b.flags &= ~F.ADS;
    if (!ai.path || now >= ai.repathAt) {
      const g = ai.state === 'chase' && ai.lastSeen ? ai.lastSeen : patrolGoal(room, b);
      ai.path = findPath(nav, px, pz, g.x, g.z); ai.pi = 0; ai.repathAt = now + rand(1200, 2200);
    }
    const path = ai.path;
    if (path && ai.pi < path.length) {
      for (let k = Math.min(path.length - 1, ai.pi + 4); k > ai.pi; k--) if (lineFree(nav, px, pz, path[k].x, path[k].z)) { ai.pi = k; break; }
      const wp = path[ai.pi], dx = wp.x - px, dz = wp.z - pz, d = Math.hypot(dx, dz);
      if (d < 0.6) ai.pi++; else { mx = dx / d; mz = dz / d; }
    } else { ai.path = null; ai.repathAt = Math.min(ai.repathAt, now + 300); }
    if (ai.state === 'chase' && ai.lastSeen) { wantYaw = Math.atan2(-(ai.lastSeen.x - px), -(ai.lastSeen.z - pz)); }
    else if (mx || mz) wantYaw = Math.atan2(-mx, -mz);
  }
  const step = P.turn * DEG * dt;
  b.yaw += clamp(angDiff(wantYaw, b.yaw), -step, step);
  b.pitch = clamp(b.pitch + clamp(wantPitch - b.pitch, -step, step), -1.5, 1.5);
  const ml = Math.hypot(mx, mz);
  if (ml > 1e-3) { if (!tryMove(nav, b, (mx / ml) * sp * dt, (mz / ml) * sp * dt)) { ai.strafe = -ai.strafe; ai.path = null; ai.repathAt = Math.min(ai.repathAt, now + 200); } }
  b.vel.x = (b.pos.x - px) / dt; b.vel.z = (b.pos.z - pz) / dt;
  if (fire && now - ai.seenSince >= ai.react && Math.abs(angDiff(wantYaw, b.yaw)) < 2.5 * DEG && Math.abs(wantPitch - b.pitch) < 2.5 * DEG) botFire(room, b, now, tDist);
}

// ───────────────────────────── 8. 전투 ─────────────────────────────
function recordHist(e, now) { const h = e.hist; h.push({ t: now, x: e.pos.x, y: e.pos.y, z: e.pos.z, c: e.flags & 3 }); if (h.length > 45) h.shift(); }
function posAt(e, t) { // 지연 보상: 과거 위치 보간
  const h = e.hist;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) {
    const a = h[i], b = h[i + 1]; if (!b) break;
    const k = (t - a.t) / (b.t - a.t || 1);
    return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k), c: a.c };
  }
  if (h.length && t < h[0].t) return h[0];
  return { x: e.pos.x, y: e.pos.y, z: e.pos.z, c: e.flags & 3 };
}
const canAct = (room, e) => e.alive && room.phase === 'live';

function startReload(room, e, now) {
  if (e.reloadUntil || (e.slot !== SLOT.secondary && e.slot !== SLOT.primary)) return;
  const key = SLOT_KEYS[e.slot], w = WEAPONS[e.loadout[key]];
  if (e.ammo[key] >= w.mag) return;
  e.reloadUntil = now + w.reloadMs; e.reloadKey = key; emitAmmo(e);
  emitRoom(room, 'reload', { id: e.id });
}
function traceShot(room, shooter, o, d, rt, maxDist) {
  const wh = raycastWorld(room.map, o, d, maxDist); let bt = wh ? wh.t : maxDist, victim = null, zone = null;
  const wallT = bt;
  for (const t of room.ents.values()) {
    if (t === shooter || !t.alive || t.team === shooter.team) continue;
    const p = shooter.isBot ? { x: t.pos.x, y: t.pos.y, z: t.pos.z, c: t.flags & 3 } : posAt(t, rt);
    const h = rayEntity(o, d, p, p.c, bt);
    if (h && h.t < bt) { bt = h.t; victim = t; zone = h.zone; }
  }
  const barrier = !victim && wh && wh.box && wh.box[6] === 'barrier' && bt === wallT ? wh.box : null;
  return { t: bt, victim, zone, barrier };
}
function fireGun(room, e, w, wid, m, now) {
  const key = SLOT_KEYS[e.slot];
  if (e.reloadUntil) return;
  const alt = !!m.alt && !!w.alt;
  let interval = 1000 / (alt ? w.alt.rps : w.rps);
  if (w.rpsMax) { if (now - e.lastShotAt > 300) e.heat = 0; interval = 1000 / lerp(w.rps, w.rpsMax, clamp(e.heat / w.rampShots, 0, 1)); } // 오딘 연사 가속
  if (now + RULES.fireTolMs < e.nextFireAt) return;
  if (e.ammo[key] <= 0) { startReload(room, e, now); return; }
  e.nextFireAt = Math.max(e.nextFireAt, now - RULES.fireTolMs) + interval;
  const shots = alt ? Math.min(w.alt.burst, e.ammo[key]) : 1;
  e.ammo[key] -= shots; e.protUntil = 0;
  if (now - e.lastShotAt > w.spread.recoverMs) e.spray = 0;
  const ads = !!(e.flags & F.ADS), scoped = !!w.zoom && ads && now - e.adsSince >= (w.scopeMs || 0);
  // 이동/점프에 의한 탄퍼짐 증가 없음. 예외: 마샬 노줌(hip) = 탄퍼짐 극대화
  const spreadDeg = w.spread.hip !== undefined && !scoped ? w.spread.hip
    : alt ? w.alt.spread : Math.min(w.spread.max, w.spread.base + w.spread.perShot * e.spray) * (ads && w.adsSpread ? w.adsSpread : 1);
  if (!e.isBot) { e.yaw = fin(m.yaw, e.yaw); e.pitch = clamp(fin(m.pitch, e.pitch), -1.55, 1.55); }
  const eye = eyeOf(e); let o = eye;
  if (!e.isBot && Array.isArray(m.o) && m.o.length === 3 && m.o.every((v) => Number.isFinite(v))) { const c = { x: m.o[0], y: m.o[1], z: m.o[2] }; if (dist3(c, eye) < 2.5) o = c; }
  const base = dirFrom(e.yaw, e.pitch), rt = clamp(fin(m.t, now), now - RULES.maxRewindMs, now);
  const n = (w.pellets || 1) * shots, ends = [], agg = new Map();
  for (let i = 0; i < n; i++) {
    const d = spreadDir(base, spreadDeg), res = traceShot(room, e, o, d, rt, 300);
    ends.push(r2(o.x + d.x * res.t), r2(o.y + d.y * res.t), r2(o.z + d.z * res.t));
    if (res.barrier) damageBarrier(room, res.barrier[7], damageAt(w, res.t, 'body'), now);
    for (const orb of [...room.orbs.values()]) if (orb.owner === e.id && raySphere(o, d, orb.pos.x, orb.pos.y, orb.pos.z, 0.5) < res.t) takeOrb(room, orb); // 구슬 사격
    if (res.victim) {
      const a = agg.get(res.victim) || { dmg: 0, head: false, zone: res.zone };
      a.dmg += damageAt(w, res.t, res.zone); if (res.zone === 'head') { a.head = true; a.zone = 'head'; }
      agg.set(res.victim, a);
      if (res.zone === 'head') e.stats.hh++; else if (res.zone === 'body') e.stats.hb++; else e.stats.hl++;
    }
  }
  e.spray += shots; e.heat++; e.lastShotAt = now; e.stats.shots += shots;
  emitRoom(room, 'shot', { id: e.id, w: wid, o: [r2(o.x), r2(o.y), r2(o.z)], h: ends, alt });
  emitAmmo(e);
  for (const [v, a] of agg) applyDamage(room, v, e, a.dmg, wid, a.zone, now);
}
function meleeAttack(room, e, w, wid, m, now) {
  if (now + RULES.fireTolMs < e.nextFireAt) return;
  e.nextFireAt = Math.max(e.nextFireAt, now - RULES.fireTolMs) + w.intervalMs; e.protUntil = 0;
  e.yaw = fin(m.yaw, e.yaw); e.pitch = clamp(fin(m.pitch, e.pitch), -1.55, 1.55);
  const eye = eyeOf(e), dir = dirFrom(e.yaw, e.pitch), rt = clamp(fin(m.t, now), now - RULES.maxRewindMs, now), cosArc = Math.cos((w.arcDeg * DEG) / 2);
  let best = null, bd = Infinity;
  for (const t of room.ents.values()) {
    if (t === e || !t.alive || t.team === e.team) continue;
    const p = posAt(t, rt), c = { x: p.x, y: p.y + (p.c ? 0.6 : 1.0), z: p.z }, d = dist3(c, eye);
    if (d > w.range + 0.4 || d >= bd) continue;
    if (d > 0.3 && ((c.x - eye.x) * dir.x + (c.y - eye.y) * dir.y + (c.z - eye.z) * dir.z) / d < cosArc) continue;
    if (!losClear(room.map, eye, c)) continue;
    bd = d; best = t;
  }
  emitRoom(room, 'melee', { id: e.id, w: wid, hit: best ? best.id : 0 });
  if (best) {
    const tf = dirFrom(best.yaw, 0), back = tf.x * dir.x + tf.z * dir.z > 0.5; // 백스탭
    applyDamage(room, best, e, Math.round(w.dmg * (back ? w.backMult : 1)), wid, 'body', now);
  }
}
function throwProj(room, e, wid, m, now) {
  const w = WEAPONS[wid];
  if (e.charges <= 0 || now < e.nextThrowAt) return;
  e.charges--; e.nextThrowAt = now + 900; e.protUntil = 0;
  if (!e.isBot) { e.yaw = fin(m.yaw, e.yaw); e.pitch = clamp(fin(m.pitch, e.pitch), -1.55, 1.55); }
  const alt = !!m.alt && wid === 'flash', dir = dirFrom(e.yaw, e.pitch), eye = eyeOf(e), sp = alt ? w.altSpeed : w.speed; // 섬광: 좌클릭 원거리 / 우클릭 언더핸드
  const start = raycastWorld(room.map, eye, dir, 0.6) ? eye : { x: eye.x + dir.x * 0.4, y: eye.y + dir.y * 0.4, z: eye.z + dir.z * 0.4 };
  const p = { id: room.nextProj++, type: wid, alt, owner: e.id, team: e.team, pos: { ...start },
    vel: { x: dir.x * sp, y: dir.y * sp + (alt ? w.altLift : w.lift), z: dir.z * sp }, explodeAt: now + (alt ? w.altFuseMs : w.fuseMs), rest: w.restitution };
  room.projs.set(p.id, p);
  emitRoom(room, 'proj:spawn', { id: p.id, type: wid, alt, owner: e.id, p: [r2(start.x), r2(start.y), r2(start.z)], v: [r2(p.vel.x), r2(p.vel.y), r2(p.vel.z)], at: p.explodeAt });
  emitAmmo(e);
}
function stepProj(room, p, dt, now) {
  if (now >= p.explodeAt) { detonate(room, p, now); return; }
  p.vel.y -= THROW_G * dt;
  let rem = dt, iter = 0;
  while (rem > 1e-5 && iter++ < 3) {
    const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z); if (sp < 0.05) break;
    const d = { x: p.vel.x / sp, y: p.vel.y / sp, z: p.vel.z / sp }, dist = sp * rem, hit = raycastWorld(room.map, p.pos, d, dist + PROJ_R);
    if (!hit) { p.pos.x += d.x * dist; p.pos.y += d.y * dist; p.pos.z += d.z * dist; break; }
    const tt = Math.max(0, hit.t - PROJ_R);
    p.pos.x += d.x * tt; p.pos.y += d.y * tt; p.pos.z += d.z * tt; rem -= tt / sp;
    if (p.type === 'zero') { detonate(room, p, now); return; } // 억제 나이프: 착탄 즉시 발동
    const ax = hit.axis === 0 ? 'x' : hit.axis === 1 ? 'y' : 'z';
    p.vel.x *= 0.82; p.vel.y *= 0.82; p.vel.z *= 0.82; p.vel[ax] = (-p.vel[ax] / 0.82) * p.rest; // 바운드
    if (hit.axis === 1 && Math.abs(p.vel.y) < 1.2) p.vel.y = 0;
  }
  if (p.pos.y < PROJ_R) { p.pos.y = PROJ_R; if (p.type === 'zero') detonate(room, p, now); }
}
function detonate(room, p, now) {
  room.projs.delete(p.id);
  const w = WEAPONS[p.type], c = { x: p.pos.x, y: p.pos.y + 0.1, z: p.pos.z }, owner = room.ents.get(p.owner);
  emitRoom(room, 'proj:explode', { id: p.id, type: p.type, p: [r2(c.x), r2(c.y), r2(c.z)] });
  if (p.type === 'zero') { // 제로/포인트: 반경 12m 내 적 감지 → Q/E/X 8초 봉인
    const sd = SKILLS.suppress;
    for (const t of room.ents.values()) {
      if (!t.alive || t.team === p.team || dist3(c, { x: t.pos.x, y: t.pos.y + 0.9, z: t.pos.z }) > sd.radius) continue;
      t.silencedUntil = now + sd.silenceMs; emitTo(t, 'silence', { until: t.silencedUntil });
      if (t.cast) cancelCast(room, t);
    }
    return;
  }
  if (p.type === 'grenade') {
    for (const wl of [...room.walls.values()]) if (dist3(c, { x: (wl.box[0] + wl.box[3]) / 2, y: 1, z: (wl.box[2] + wl.box[5]) / 2 }) < w.radius) damageBarrier(room, wl.id, 120, now);
    if (!owner) return;
    for (const t of [...room.ents.values()]) {
      if (!t.alive || (t !== owner && t.team === p.team)) continue;
      const tc = { x: t.pos.x, y: t.pos.y + 0.9, z: t.pos.z }, d = dist3(c, tc);
      if (d >= w.radius || !losClear(room.map, c, tc)) continue;
      let dmg = Math.max(w.minDmg, Math.round(w.maxDmg * (1 - Math.pow(d / w.radius, 1.2))));
      if (t === owner) dmg = Math.round(dmg * w.selfMult);
      applyDamage(room, t, owner, dmg, 'grenade', 'body', now);
    }
  } else { // 섬광: 시야 내 적만 실명 (시선 각도·거리 비례)
    const maxMs = p.alt ? w.altMaxBlindMs : w.maxBlindMs;
    for (const t of room.ents.values()) {
      if (!t.alive || t.team === p.team) continue;
      const eye = eyeOf(t); if (!losClear(room.map, eye, c)) continue;
      const dx = c.x - eye.x, dy = c.y - eye.y, dz = c.z - eye.z, d = Math.hypot(dx, dy, dz) || 1e-3, v = dirFrom(t.yaw, t.pitch);
      const ang = Math.acos(clamp((dx * v.x + dy * v.y + dz * v.z) / d, -1, 1)) / DEG;
      const af = ang <= 60 ? 1 : ang <= 110 ? lerp(1, 0.15, (ang - 60) / 50) : 0.12, df = d < 25 ? 1 : clamp(lerp(1, 0.4, (d - 25) / 35), 0.4, 1);
      const dur = Math.round(maxMs * af * df); if (dur < 150) continue;
      t.flashedUntil = Math.max(t.flashedUntil, now + dur);
      emitTo(t, 'flash', { dur, by: p.owner, full: af === 1 });
    }
  }
}
function applyDamage(room, victim, attacker, dmg, wid, zone, now) {
  if (!victim.alive || dmg <= 0 || room.phase !== 'live' || now < victim.protUntil) return;
  const self = attacker === victim;
  if (!self && attacker.team === victim.team) return;
  if (room.mode === 'range' && !victim.ai?.dummy) return;
  if (now < victim.driftUntil) return; // 요루 궁극기: 무적
  if (!self && now < attacker.ampUntil && WEAPONS[wid]?.type === 'gun') dmg = Math.round(dmg * SKILLS.amp.mult); // 데미지 증폭 x1.4
  if (victim.shield > 0 && !self) { // 아이소 보호막: 1회 완전 방어
    victim.shield = 0; emitTo(victim, 'shield', { on: false, broke: true }); emitTo(attacker, 'hit', { v: victim.id, d: 0, z: zone, k: false }); return;
  }
  dmg = Math.min(dmg, victim.hp); victim.hp -= dmg; victim.healUntil = 0; // 회복 중 피격 -> 중단
  if (victim.cast) cancelCast(room, victim); // 오멘 시전 중 피격 -> 취소
  if (!self) { attacker.stats.dmg += dmg; const rec = victim.dmgLog.get(attacker.id); victim.dmgLog.set(attacker.id, { dmg: (rec?.dmg || 0) + dmg, t: now }); }
  const killed = victim.hp <= 0;
  emitTo(attacker, 'hit', { v: victim.id, d: dmg, z: zone, k: killed });
  emitTo(victim, 'hurt', { a: attacker.id, d: dmg, hp: victim.hp, from: [r2(attacker.pos.x), r2(attacker.pos.z)] });
  if (victim.isBot && !victim.ai.dummy && !self && victim.ai.state !== 'engage') { // 피격 인지
    victim.ai.lastSeen = { ...attacker.pos }; victim.ai.lastSeenAt = now; victim.ai.state = 'chase'; victim.ai.path = null; victim.ai.repathAt = 0;
  }
  if (killed) kill(room, victim, attacker, wid, zone === 'head', now);
}
function kill(room, victim, killer, wid, hs, now) {
  victim.alive = false; victim.hp = 0; victim.stats.d++; victim.reloadUntil = 0; victim.reloadKey = null;
  const self = killer === victim, assists = [];
  if (!self) {
    killer.stats.k++; if (hs) killer.stats.hsk++;
    if (WEAPONS[wid]?.type === 'melee') killer.stats.melee++; if (wid === 'grenade') killer.stats.nade++;
    for (const [aid, rec] of victim.dmgLog) {
      const a = room.ents.get(aid);
      if (a && aid !== killer.id && now - rec.t <= RULES.assistWindowMs && rec.dmg >= 20) { a.stats.a++; assists.push(aid); }
    }
  }
  victim.dmgLog.clear();
  if (victim.cast) cancelCast(room, victim); victim.healUntil = 0;
  addUlt(victim, 1);
  if (!self) { addUlt(killer, 1); if (killer.alive && now < killer.shieldBuffUntil) spawnOrb(room, killer, victim, now); }
  if (room.mode === 'tdm' && !self) room.score[killer.team]++;
  emitRoom(room, 'kill', { k: killer.id, v: victim.id, w: wid, hs, a: assists, s: room.score });
  if (room.mode === 'tdm') {
    victim.respawnAt = now + RULES.tdmRespawnMs; // 사망 즉시 베이스 부활
    if (room.score[killer.team] >= room.teamSize * RULES.tdmKillsPerPlayer) endMatch(room, killer.team, now);
  } else if (room.mode === 'range') victim.respawnAt = now + RULES.rangeRespawnMs;
  else checkRoundEnd(room, now);
}
const skillOf = (e, k) => (Object.hasOwn(SKILLS, e.loadout[k]) ? e.loadout[k] : k === 'q' ? 'updraft' : 'haste');
function addUlt(e, n) { if (e.isBot) return; e.ult = clamp(e.ult + n, 0, ULT_COST); emitTo(e, 'ult:pts', { p: e.ult }); }
function teleport(e, x, y, z, yaw, now) { // 서버 권위 순간이동 -> 클라이언트에 위치 보정 전송
  e.pos = { x, y, z }; e.vel = { x: 0, y: 0, z: 0 }; e.lastMoveAt = now; e.violations = 0; e.hist.length = 0;
  if (yaw !== undefined) e.yaw = yaw;
  emitTo(e, 'pos:correct', { p: [r2(x), r2(y), r2(z)], s: e.spawnSeq, yaw: yaw === undefined ? undefined : r3(yaw) });
}
function useSkill(room, e, k, now, m = {}) {
  if (k === 'x') return useUlt(room, e, now, m);
  if ((k !== 'q' && k !== 'e') || now < e.skillAt[k] || now < e.silencedUntil || now < e.driftUntil || e.cast) return false;
  const id = skillOf(e, k), def = SKILLS[id], left = def.uses - (e.uses[id] || 0);
  if (left <= 0) return false;
  let until = 0;
  if (id === 'barrier') { if (!placeBarrier(room, e, now)) return false; }
  else if (id === 'haste') until = e.dashUntil = now + def.ms;
  else if (id === 'amp') until = e.ampUntil = now + def.ms;
  else if (id === 'heal') { until = e.healUntil = now + def.ms; e.healAcc = 0; }
  else if (id === 'shield') until = e.shieldBuffUntil = now + def.ms;
  else if (id === 'suppress') throwKnife(room, e, now);
  e.uses[id] = (e.uses[id] || 0) + 1; e.skillAt[k] = now + def.cd;
  emitRoom(room, 'skill', { id: e.id, k, s: id, cd: e.skillAt[k], until, u: def.uses - e.uses[id] });
  return true;
}
function throwKnife(room, e, now) { // 제로/포인트 억제 나이프
  const sd = SKILLS.suppress, dir = dirFrom(e.yaw, e.pitch), eye = eyeOf(e);
  const start = raycastWorld(room.map, eye, dir, 0.6) ? eye : { x: eye.x + dir.x * 0.4, y: eye.y + dir.y * 0.4, z: eye.z + dir.z * 0.4 };
  const p = { id: room.nextProj++, type: 'zero', alt: false, owner: e.id, team: e.team, pos: { ...start },
    vel: { x: dir.x * sd.speed, y: dir.y * sd.speed + sd.lift, z: dir.z * sd.speed }, explodeAt: now + 3000, rest: 0.3 };
  room.projs.set(p.id, p);
  emitRoom(room, 'proj:spawn', { id: p.id, type: 'zero', alt: false, owner: e.id, p: [r2(start.x), r2(start.y), r2(start.z)], v: [r2(p.vel.x), r2(p.vel.y), r2(p.vel.z)], at: p.explodeAt });
}
function placeBarrier(room, e, now) { // 장벽(세이지 벽): 조준한 바닥 지점에 AABB 충돌체 생성
  const sd = SKILLS.barrier, eye = eyeOf(e), dir = dirFrom(e.yaw, e.pitch), hit = raycastWorld(room.map, eye, dir, sd.range);
  if (!hit) return false;
  const cx = eye.x + dir.x * hit.t, cz = eye.z + dir.z * hit.t, by = hit.axis === 1 ? Math.max(0, eye.y + dir.y * hit.t) : 0;
  const alongZ = Math.abs(Math.sin(e.yaw)) > Math.abs(Math.cos(e.yaw)); // 시선과 수직으로 펼침
  const hw = (alongZ ? sd.t : sd.w) / 2, hd = (alongZ ? sd.w : sd.t) / 2, bd = room.map.bounds;
  if (cx - hw < bd.x0 || cx + hw > bd.x1 || cz - hd < bd.z0 || cz + hd > bd.z1) return false;
  const box = [cx - hw, by, cz - hd, cx + hw, by + sd.h, cz + hd, 'barrier', 0];
  for (const t of room.ents.values()) if (t.alive && t.pos.x + 0.5 > box[0] && t.pos.x - 0.5 < box[3] && t.pos.z + 0.5 > box[2] && t.pos.z - 0.5 < box[5] && t.pos.y < box[4] && t.pos.y + 1.8 > box[1]) return false; // 사람 위에는 설치 불가
  const mine = [...room.walls.values()].filter((w) => w.owner === e.id);
  if (mine.length >= sd.maxPerOwner) removeBarrier(room, mine[0].id);
  const id = room.nextWall++; box[7] = id;
  room.map.boxes.push(box); room.walls.set(id, { id, box, hp: sd.hp, owner: e.id, until: now + sd.lifeMs });
  emitRoom(room, 'wall:add', { id, b: box.slice(0, 6).map(r2), hp: sd.hp, o: e.id });
  return true;
}
function removeBarrier(room, id) {
  const w = room.walls.get(id); if (!w) return;
  room.walls.delete(id); const i = room.map.boxes.indexOf(w.box); if (i >= 0) room.map.boxes.splice(i, 1);
  emitRoom(room, 'wall:del', { id });
}
function damageBarrier(room, id, dmg, now) {
  const w = room.walls.get(id); if (!w || room.phase !== 'live') return;
  w.hp -= dmg;
  if (w.hp <= 0) removeBarrier(room, id); else emitRoom(room, 'wall:hp', { id, hp: Math.round(w.hp) });
}
function spawnOrb(room, killer, victim, now) { // 아이소 보호막: 처치 위치에 에너지 구슬
  const id = room.nextOrb++, orb = { id, owner: killer.id, pos: { x: victim.pos.x, y: victim.pos.y + 0.9, z: victim.pos.z }, until: now + SKILLS.shield.orbMs };
  room.orbs.set(id, orb); emitRoom(room, 'orb:add', { id, o: killer.id, p: [r2(orb.pos.x), r2(orb.pos.y), r2(orb.pos.z)] });
}
function takeOrb(room, orb) {
  room.orbs.delete(orb.id); emitRoom(room, 'orb:del', { id: orb.id });
  const o = room.ents.get(orb.owner); if (o && o.alive) { o.shield = 1; emitTo(o, 'shield', { on: true }); }
}
function cancelCast(room, e) { if (!e.cast) return; e.cast = null; emitRoom(room, 'ult', { id: e.id, s: 'omen', ph: 'cancel' }); }

function useUlt(room, e, now, m) {
  if (e.ult < ULT_COST || e.cast || now < e.silencedUntil || now < e.driftUntil || e.duel) return false;
  const id = Object.hasOwn(ULTS, e.loadout.x) ? e.loadout.x : 'omen', def = ULTS[id];
  if (id === 'omen') { // 그림자 습격: 지정 좌표로 순간이동 (시전 중 피격 시 취소)
    const t = m.t; if (!Array.isArray(t) || t.length !== 2 || !t.every(Number.isFinite)) return false;
    const bd = room.map.bounds, x = clamp(t[0], bd.x0 + 1, bd.x1 - 1), z = clamp(t[1], bd.z0 + 1, bd.z1 - 1);
    if (insideSolid(room.map, x, 0.9, z) || insideSolid(room.map, x, 0.3, z)) return false;
    e.cast = { id, until: now + def.castMs, x, z };
    emitRoom(room, 'ult', { id: e.id, s: id, ph: 'cast', until: e.cast.until, p: [r2(x), r2(z)] });
  } else if (id === 'yoru') { // 차원 표류: 무적/은신/고속 이동 (공격 불가)
    e.ult = 0; e.driftUntil = now + def.ms; e.protUntil = 0;
    emitTo(e, 'ult:pts', { p: 0 }); emitRoom(room, 'ult', { id: e.id, s: id, ph: 'start', until: e.driftUntil });
  } else if (id === 'iso') { // 청부 계약: 전방 직선 파동에 맞은 적 1명과 1:1 격리 아레나로
    if (!room.map.duel) return false;
    const eye = eyeOf(e), dir = dirFrom(e.yaw, e.pitch); let best = null, bt = def.range;
    for (const t of room.ents.values()) {
      if (!t.alive || t.team === e.team || t.duel || now < t.driftUntil) continue;
      const c = { x: t.pos.x, y: t.pos.y + 0.9, z: t.pos.z }, tt = (c.x - eye.x) * dir.x + (c.y - eye.y) * dir.y + (c.z - eye.z) * dir.z;
      if (tt < 0 || tt > bt) continue;
      if (Math.hypot(c.x - (eye.x + dir.x * tt), c.y - (eye.y + dir.y * tt), c.z - (eye.z + dir.z * tt)) > def.width || !losClear(room.map, eye, c)) continue;
      bt = tt; best = t;
    }
    emitRoom(room, 'ult', { id: e.id, s: id, ph: 'wave', o: [r2(eye.x), r2(eye.y), r2(eye.z)], d: [r3(dir.x), r3(dir.y), r3(dir.z)], hit: best ? best.id : 0 });
    if (!best) return false;
    e.ult = 0; emitTo(e, 'ult:pts', { p: 0 }); startDuel(room, e, best, now);
  }
  return true;
}
function startDuel(room, a, b, now) {
  const D = room.map.duel, d = { a: a.id, b: b.id, until: now + ULTS.iso.ms, oa: { x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: a.yaw }, ob: { x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: b.yaw } };
  room.duels.push(d); a.duel = d; b.duel = d; a.cast = b.cast = null; a.healUntil = b.healUntil = 0;
  teleport(a, D.spawns[0].x, 0, D.spawns[0].z, D.spawns[0].yaw, now); teleport(b, D.spawns[1].x, 0, D.spawns[1].z, D.spawns[1].yaw, now);
  for (const x of [a, b]) { refill(x); emitAmmo(x); x.slot = SLOT.primary; x.nextFireAt = now + 500; }
  emitRoom(room, 'duel', { a: a.id, b: b.id, until: d.until });
}
function endDuel(room, d, now) {
  const i = room.duels.indexOf(d); if (i >= 0) room.duels.splice(i, 1);
  const A = room.ents.get(d.a), B = room.ents.get(d.b);
  for (const [x, o] of [[A, d.oa], [B, d.ob]]) if (x) { x.duel = null; if (x.alive) teleport(x, o.x, o.y, o.z, o.yaw, now); } // 승자만 원위치 복귀
  emitRoom(room, 'duel:end', { a: d.a, b: d.b, w: A?.alive ? d.a : B?.alive ? d.b : 0 });
}
function tickSkills(room, now, dt) {
  for (const e of room.ents.values()) {
    if (!e.alive) continue;
    if (e.healUntil) { // 4초에 걸쳐 총 60 회복 (경과 비율 기준 → 오차 없음)
      const sd = SKILLS.heal, target = Math.round(sd.total * clamp(1 - (e.healUntil - now) / sd.ms, 0, 1)), inc = target - e.healAcc;
      if (inc > 0) { e.healAcc = target; e.hp = Math.min(RULES.hp, e.hp + inc); }
      if (now >= e.healUntil) e.healUntil = 0;
    }
    if (e.driftUntil && now >= e.driftUntil) { e.driftUntil = 0; e.nextFireAt = Math.max(e.nextFireAt, now + ULTS.yoru.afterMs); e.nextThrowAt = Math.max(e.nextThrowAt, now + ULTS.yoru.afterMs); emitRoom(room, 'ult', { id: e.id, s: 'yoru', ph: 'end' }); }
    if (e.cast && now >= e.cast.until) { const c = e.cast; e.cast = null; e.ult = 0; emitTo(e, 'ult:pts', { p: 0 }); teleport(e, c.x, 0, c.z, undefined, now); emitRoom(room, 'ult', { id: e.id, s: 'omen', ph: 'done', p: [r2(c.x), r2(c.z)] }); }
  }
  for (const orb of [...room.orbs.values()]) {
    const o = room.ents.get(orb.owner);
    if (now >= orb.until || !o) { room.orbs.delete(orb.id); emitRoom(room, 'orb:del', { id: orb.id }); continue; }
    if (o.alive && dist3({ x: o.pos.x, y: o.pos.y + 0.9, z: o.pos.z }, orb.pos) < 1.3) takeOrb(room, orb); // 접촉
  }
  for (const w of [...room.walls.values()]) if (now >= w.until) removeBarrier(room, w.id);
  for (const d of [...room.duels]) {
    const A = room.ents.get(d.a), B = room.ents.get(d.b);
    if (!A || !B || !A.alive || !B.alive) { endDuel(room, d, now); continue; }
    if (now >= d.until) { const win = A.hp > B.hp ? A : B, lose = win === A ? B : A; applyDuelLoss(room, lose, win, now); } // 시간 종료: 체력 높은 쪽 승리(동점이면 대상 승리)
  }
}
function applyDuelLoss(room, loser, winner, now) {
  const d = loser.duel; loser.duel = null; winner.duel = null;
  if (d) { const i = room.duels.indexOf(d); if (i >= 0) room.duels.splice(i, 1); }
  kill(room, loser, winner, 'iso', false, now);
  if (d && winner.alive) { const o = winner.id === d.a ? d.oa : d.ob; teleport(winner, o.x, o.y, o.z, o.yaw, now); }
  emitRoom(room, 'duel:end', { a: d?.a ?? 0, b: d?.b ?? 0, w: winner.id });
}

// ───────────────────────────── 9. 모드 / 페이즈 ─────────────────────────────
function startMatch(room, now) {
  room.score = [0, 0]; room.round = 0; room.projs.clear();
  for (const e of room.ents.values()) { e.stats = newStats(); e.persisted = false; e.skillAt = { q: 0, e: 0 }; e.ult = 0; }
  if (room.fillBots) fillBots(room, now);
  emitRoom(room, 'room:state', roomState(room));
  startRound(room, now);
}
function startRound(room, now) {
  room.round++; room.phase = 'buy'; room.endsAt = now + (room.mode === 'tdm' ? RULES.tdmWarmupMs : RULES.buyMs); room.projs.clear();
  room.walls.clear(); room.orbs.clear(); room.duels.length = 0; room.map.boxes = room.map.boxes.filter((b) => b[6] !== 'barrier'); // 장벽/구슬/결투 초기화
  if (room.round > 1) for (const e of room.ents.values()) addUlt(e, 1); // 라운드 전환 +1
  const spawns = [];
  for (const t of [0, 1]) teamEnts(room, t).forEach((e, i) => { spawns.push(spawnEntity(room, e, room.map.spawns[t][i % room.map.spawns[t].length], now)); });
  emitPhase(room, { spawns });
}
function checkRoundEnd(room, now) {
  if (!isRound(room) || room.phase !== 'live') return;
  const a0 = teamEnts(room, 0).some((e) => e.alive), a1 = teamEnts(room, 1).some((e) => e.alive);
  if (a0 && a1) return;
  endRound(room, a0 ? 0 : a1 ? 1 : -1, now);
}
function endRound(room, winner, now) {
  if (winner >= 0) room.score[winner]++;
  room.phase = 'roundEnd'; room.endsAt = now + RULES.roundEndMs;
  emitPhase(room, { winner });
}
function rpDelta(room, e, won) { // Elo 기반 RP 증감
  const en = teamEnts(room, 1 - e.team), opp = en.length ? en.reduce((s, o) => s + o.rp, 0) / en.length : e.rp;
  const exp = 1 / (1 + Math.pow(10, (opp - e.rp) / 800));
  const mates = teamEnts(room, e.team), top = mates.every((m) => m.stats.k <= e.stats.k) ? 3 : 0;
  return won ? clamp(Math.round(40 * (1 - exp)) + top, 10, 40) : -clamp(Math.round(40 * exp) - top, 5, 35);
}
const matchResultOf = (e, winner) => (winner < 0 ? 'draw' : e.team === winner ? 'win' : 'loss');
const matchCredits = (room, e, result) => (room.isPrivate ? 10 : result === 'left' ? 0 : (result === 'win' ? 1000 : 500) + e.stats.k * 25);
const combatScore = (s) => s.k * 200 + s.a * 100 + Math.round(s.dmg); // 킬 200 + 어시스트 100 + 피해 1당 1점
/** 매치 종료 요약: 팀 스코어, 참가자별 상세 기록(전투 점수 내림차순), 매치/팀 MVP. 읽기 전용 — e.stats 를 변경하지 않는다 */
export function matchSummary(room, winner) {
  const players = [...room.ents.values()].filter((e) => !e.ai?.dummy).map((e) => ({
    userId: e.id, nickname: e.name, team: e.team, bot: e.isBot,
    kills: e.stats.k, deaths: e.stats.d, assists: e.stats.a, damageDealt: Math.round(e.stats.dmg), headshots: e.stats.hsk,
    combatScore: combatScore(e.stats), earnedCredits: e.isBot ? 0 : matchCredits(room, e, matchResultOf(e, winner)),
  })).sort((a, b) => b.combatScore - a.combatScore || b.kills - a.kills || a.deaths - b.deaths || a.userId - b.userId);
  const teamMvpId = [0, 1].map((t) => players.find((p) => p.team === t)?.userId ?? 0);
  return { winner, winnerTeam: winner < 0 ? null : winner === 0 ? 'teamA' : 'teamB', score: room.score, teamScore: { teamA: room.score[0], teamB: room.score[1] },
    players, matchMvpId: players[0]?.userId ?? 0, teamMvpId };
}
async function persist(room, e, result, now) {
  if (e.persisted || e.isBot) return; e.persisted = true;
  const s = e.stats, won = result === 'win', ranked = room.mode === 'ranked';
  const rp = ranked && result !== 'draw' ? (result === 'left' ? Math.min(-20, rpDelta(room, e, false)) : rpDelta(room, e, won)) : 0;
  const credits = matchCredits(room, e, result);
  const reward = { result, rp_delta: rp, credits, saved: false };
  if (supabase && e.userId && !room.isPrivate && room.mode !== 'range') {
    try {
      const { data, error } = await supabase.rpc('apply_match_result', { p_user: e.userId, p_result: {
        mode: room.mode, map: room.mapId, team_size: room.teamSize, result, kills: s.k, deaths: s.d, assists: s.a, headshot_kills: s.hsk,
        hits_head: s.hh, hits_body: s.hb, hits_leg: s.hl, shots_fired: s.shots, damage: s.dmg, rp_delta: rp, credits,
        counters: { kills: s.k, headshot_kills: s.hsk, assists: s.a, damage: s.dmg, matches: 1, wins: won ? 1 : 0, melee_kills: s.melee, nade_kills: s.nade,
          ranked_matches: ranked ? 1 : 0, tdm_kills: room.mode === 'tdm' ? s.k : 0 },
      } });
      if (error) throw error;
      Object.assign(reward, data, { saved: true });
      if (e.sess) { e.sess.rp = data.rank_points; e.rp = data.rank_points; }
    } catch (err) { console.error('[persist]', err.message || err); }
  }
  emitTo(e, 'match:reward', reward);
}
function endMatch(room, winner, now) {
  if (room.phase === 'ended') return;
  room.phase = 'ended'; room.endsAt = now + RULES.endMs; room.projs.clear();
  emitRoom(room, 'match:end', matchSummary(room, winner));
  emitPhase(room, { winner });
  for (const e of humans(room)) persist(room, e, matchResultOf(e, winner), now);
}
function closeMatch(room, now) {
  if (!room.isPrivate) { emitRoom(room, 'room:closed', { reason: 'MATCH_OVER' }); destroyRoom(room); return; }
  for (const e of [...room.ents.values()]) if (e.isBot) room.ents.delete(e.id); else { e.alive = false; e.stats = newStats(); }
  room.phase = 'lobby'; room.endsAt = 0; room.score = [0, 0]; room.round = 0;
  emitRoom(room, 'room:state', roomState(room));
}
function tickPhase(room, now) {
  if (room.mode === 'range' || room.phase === 'lobby' || now < room.endsAt) return;
  if (room.phase === 'buy') { room.phase = 'live'; room.endsAt = now + (room.mode === 'tdm' ? RULES.tdmTimeMs : RULES.roundMs); emitPhase(room); }
  else if (room.phase === 'live') {
    if (room.mode === 'tdm') endMatch(room, room.score[0] === room.score[1] ? -1 : room.score[0] > room.score[1] ? 0 : 1, now);
    else { // 시간 초과: 생존자 수 → 총 HP 순
      const s = [0, 1].map((t) => teamEnts(room, t).filter((e) => e.alive)), n0 = s[0].length, n1 = s[1].length;
      const h0 = s[0].reduce((a, e) => a + e.hp, 0), h1 = s[1].reduce((a, e) => a + e.hp, 0);
      endRound(room, n0 !== n1 ? (n0 > n1 ? 0 : 1) : h0 !== h1 ? (h0 > h1 ? 0 : 1) : -1, now);
    }
  } else if (room.phase === 'roundEnd') {
    const w = room.score[0] >= RULES.roundsToWin ? 0 : room.score[1] >= RULES.roundsToWin ? 1 : -1;
    if (w >= 0) endMatch(room, w, now); else startRound(room, now);
  } else if (room.phase === 'ended') closeMatch(room, now);
}

function tickRoom(room, now, dt) {
  tickPhase(room, now);
  if (!rooms.has(room.id)) return;
  const live = room.phase === 'live';
  for (const e of [...room.ents.values()]) {
    if (e.reloadUntil && now >= e.reloadUntil) { e.ammo[e.reloadKey] = WEAPONS[e.loadout[e.reloadKey]].mag; e.reloadUntil = 0; e.reloadKey = null; emitAmmo(e); }
    if (!e.alive && e.respawnAt && now >= e.respawnAt && live) emitRoom(room, 'spawn', { s: spawnEntity(room, e, e.ai?.dummy ? e.ai.home : pickSpawn(room, e), now) });
    if (e.isBot && e.alive && live) { if (!e.ai.dummy && now >= e.ai.thinkAt) botThink(room, e, now); if (e.alive) botAct(room, e, now, dt); }
    if (e.alive) recordHist(e, now);
  }
  if (live) { for (const p of [...room.projs.values()]) stepProj(room, p, dt, now); tickSkills(room, now, dt); }
  if (now - room.lastSnap >= RULES.snapMs && room.phase !== 'lobby') {
    room.lastSnap = now;
    const arr = [];
    for (const e of room.ents.values()) {
      let f = e.flags & 15;
      if (e.alive) f |= F.ALIVE; if (now < e.protUntil) f |= F.PROT; if (e.reloadUntil) f |= F.RELOAD; if (now < e.flashedUntil) f |= F.FLASHED; if (now < e.dashUntil) f |= F.DASH;
      if (now < e.ampUntil) f |= F.AMP; if (now < e.silencedUntil) f |= F.SILENCED; if (e.shield > 0) f |= F.SHIELD; if (now < e.healUntil) f |= F.HEAL; if (now < e.driftUntil) f |= F.INVIS; if (e.cast) f |= F.CAST;
      arr.push([e.id, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r3(e.yaw), r3(e.pitch), f, e.hp, e.slot]);
    }
    const pj = []; for (const p of room.projs.values()) pj.push([p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)]);
    io.to(room.id).volatile.emit('snap', { t: now, e: arr, p: pj, s: room.score });
  }
}
let lastTick = 0;
export function tickAll(now = clock.now()) {
  const dt = clamp((now - (lastTick || now - 33)) / 1000, 0.001, 0.1); lastTick = now;
  for (const room of [...rooms.values()]) { try { tickRoom(room, now, dt); } catch (err) { console.error('[tick]', room.id, err); } }
}

// ───────────────────────────── 10. 입장 / 퇴장 / 매칭 ─────────────────────────────
function addHuman(room, sess, now) {
  const cnt = [0, 1].map((t) => teamEnts(room, t).filter((e) => !e.isBot).length);
  const order = room.mode === 'range' ? [0] : cnt[0] <= cnt[1] ? [0, 1] : [1, 0];
  let team = -1, bot = null;
  for (const t of order) { const list = teamEnts(room, t); bot = list.find((e) => e.isBot && !e.ai.dummy) || null; if (bot || list.length < room.teamSize) { team = t; break; } }
  if (team < 0) return null;
  const e = newEntity(room, { sess, userId: sess.userId, name: sess.name, rp: sess.rp, level: tierLevel(sess.rp, sess.rankPos), title: sess.title, skins: sess.skins, career: sess.career, team, loadout: { ...sess.loadout } });
  sess.room = room; sess.ent = e; sess.socket.join(room.id);
 if (!room.hostId || !room.ents.has(room.hostId) || room.ents.get(room.hostId)?.isBot) room.hostId = e.id;
  let spawn = null;
  if (room.phase !== 'lobby' && room.phase !== 'ended') {
    if (!isRound(room)) spawn = spawnEntity(room, e, pickSpawn(room, e), now);
    else if (bot && bot.alive) { // 라운드 진행 중: 봇의 위치·체력을 그대로 인계
      spawn = spawnEntity(room, e, { ...bot.pos, yaw: bot.yaw }, now); e.hp = bot.hp;
    }
  }
  if (bot) room.ents.delete(bot.id);
  sess.socket.emit('room:joined', { you: e.id, room: roomState(room), map: mapPublic(room.map), serverTime: now, rules: RULES, spawn });
  sess.socket.to(room.id).emit(bot ? 'roster:swap' : 'roster:add', { out: bot ? bot.id : 0, in: pub(e), host: room.hostId, spawn });
  return e;
}
function removeHuman(sess, now) {
  const room = sess.room, e = sess.ent; if (!room || !e) return;
  sess.room = null; sess.ent = null; sess.socket.leave(room.id);
  const active = room.phase !== 'lobby' && room.phase !== 'ended';
  if (active && room.mode !== 'range') { e.sess = sess; persist(room, e, 'left', now); }
  room.ents.delete(e.id);
  const hs = humans(room);
  if (!hs.length) { destroyRoom(room); return; }
  if (room.hostId === e.id) room.hostId = hs[0].id;
  if (room.fillBots && active) { // 이탈자 자리를 봇이 즉시 대체
    const b = addBot(room, e.team, now); let spawn = null;
    if (!isRound(room)) spawn = spawnEntity(room, b, pickSpawn(room, b), now);
    else if (e.alive) { spawn = spawnEntity(room, b, { ...e.pos, yaw: e.yaw }, now); b.hp = e.hp; }
    emitRoom(room, 'roster:swap', { out: e.id, in: pub(b), host: room.hostId, spawn });
  } else { emitRoom(room, 'roster:remove', { id: e.id, host: room.hostId }); checkRoundEnd(room, now); }
}
function findRoom(mode, teamSize, mapId, sess) {
  for (const room of rooms.values()) {
    if (room.isPrivate || room.mode !== mode || room.teamSize !== teamSize || room.phase === 'ended' || room.phase === 'lobby') continue;
    if (mapId && room.mapId !== mapId) continue;
    if (isRound(room) && Math.max(...room.score) >= RULES.roundsToWin - 1) continue;
    if (mode === 'ranked') { const hs = humans(room); if (Math.abs(hs.reduce((s, e) => s + e.rp, 0) / (hs.length || 1) - sess.rp) > 600) continue; }
    if ([...room.ents.values()].some((e) => e.isBot) || room.ents.size < teamSize * 2) return room;
  }
  return null;
}
function createRange(sess, now) {
  const room = createRoom({ mode: 'range', teamSize: 1, mapId: 'range', isPrivate: true, fillBots: false });
  for (const d of room.map.dummies) {
    const b = newEntity(room, { isBot: true, name: 'Dummy', team: 1, level: 0 });
    b.ai = { P: botParams(0), dummy: true, home: d }; resetAi(b, now); spawnEntity(room, b, d, now);
  }
  room.phase = 'live'; room.endsAt = 0;
  return room;
}

// ───────────────────────────── 11. 인증 / 프로필 ─────────────────────────────
async function loadTitles(now) {
  if (!supabase || now - titleCacheAt < 600000) return;
  titleCacheAt = now;
  const { data } = await supabase.from('achievements').select('achievement_id,title');
  if (data) titleCache = new Map(data.map((r) => [r.achievement_id, r.title]));
}
async function loadProfile(sess) {
  await loadTitles(clock.now());
  const selProfile = () => supabase.from('profiles').select('nickname,rank_points,equipped_title,loadout' + (BAN_COLS ? ',banned_until' : '')).eq('id', sess.userId).maybeSingle();
  let p = await selProfile();
  if (p.error && /banned_until/.test(p.error.message)) { BAN_COLS = false; p = await selProfile(); } // 정지 컬럼 마이그레이션 전이면 정지 기능만 비활성
  if (!p.error && !p.data) { // auth.users 에는 있으나 profiles 행이 없음 → 기본값으로 자동 생성
    const r = await supabase.rpc('create_profile_for', { p_id: sess.userId });
    if (r.error) { // RPC 미배포/실패 → service_role 로 직접 insert (스키마 마이그레이션 누락 대비)
      console.error('[profile] rpc create_profile_for failed:', r.error.message);
      const base = (sess.meta?.nickname || sess.meta?.full_name || sess.meta?.name || 'Player').toString().replace(/[^A-Za-z0-9가-힣_]/g, '').slice(0, 12);
      let nick = base.length >= 2 ? base : 'Player';
      for (let i = 0; i < 8; i++) { // 닉네임 중복(unique) 시 숫자 접미사로 재시도
        const up = await supabase.from('profiles').upsert({ id: sess.userId, nickname: nick }, { onConflict: 'id', ignoreDuplicates: true });
        if (!up.error) break;
        console.error('[profile] direct upsert failed:', up.error.message);
        nick = (base.length >= 2 ? base : 'Player') + randInt(1000, 9999);
      }
    }
    p = await selProfile();
  }
  if (p.error) console.error('[profile] select failed:', p.error.message);
  const [st, sk] = await Promise.all([
    supabase.from('player_stats_total').select('kd,hs_pct,win_rate,matches').eq('user_id', sess.userId).maybeSingle(),
    supabase.from('user_skins').select('weapon_id,skin_id').eq('user_id', sess.userId).eq('equipped', true),
  ]);
  if (p.error || !p.data) throw new Error('PROFILE_NOT_FOUND');
  if (p.data.banned_until && new Date(p.data.banned_until).getTime() > Date.now()) throw new Error('BANNED:' + new Date(p.data.banned_until).toISOString());
  sess.name = p.data.nickname; sess.rp = p.data.rank_points; sess.title = titleCache.get(p.data.equipped_title) || null;
  sess.loadout = sanitizeLoadout(p.data.loadout);
  sess.career = st.data ? { kd: +st.data.kd, hs: +st.data.hs_pct, wr: +st.data.win_rate, matches: st.data.matches } : { kd: 0, hs: 0, wr: 0, matches: 0 };
  sess.skins = Object.fromEntries((sk.data || []).map((r) => [r.weapon_id, r.skin_id]));
  sess.rankPos = null;
  if (sess.rp >= 3600) { const { data } = await supabase.rpc('rank_position', { p_user: sess.userId }); sess.rankPos = data || null; }
}
/** 관리자 계정 검색: UUID / 이메일(auth.users) / 닉네임·아이디(부분 일치) 모두 지원. [{id,nickname,username,credits,email?}] 반환 */
let BAN_COLS = true; // supabase_account_admin.sql 적용 여부(미적용이면 자동 false)
const profileCols = () => 'id,nickname,username,credits,rank_points' + (BAN_COLS ? ',banned_until,ban_reason' : '');
async function findAccounts(q) {
  try { return await findAccountsRaw(q); }
  catch (e) { if (BAN_COLS && /banned_until|ban_reason/.test(e?.message || '')) { BAN_COLS = false; return findAccountsRaw(q); } throw e; }
}
async function findAccountsRaw(rawIn) {
  const PROFILE_COLS = profileCols();
  const raw = String(rawIn ?? '').normalize('NFC').trim().replace(/^["'<\s]+|["'>\s]+$/g, '').slice(0, 80);
  if (!raw) return [];
  if (UUID_RE.test(raw)) { const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('id', raw.toLowerCase()); if (error) throw error; return data; }
  const ids = new Set(), emails = new Map();
  if (raw.includes('@')) { // 이메일: service_role 로 auth.users 를 훑어 일치/부분 일치 계정을 찾는다
    const want = raw.toLowerCase();
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) { console.error('[admin] listUsers', error.message); break; }
      for (const u of data.users) if (u.email && u.email.toLowerCase().includes(want)) { ids.add(u.id); emails.set(u.id, u.email); }
      if (data.users.length < 1000) break;
    }
  }
  const local = raw.split('@')[0].replace(/[^A-Za-z0-9가-힣_.-]/g, ''), term = raw.includes('@') ? local : raw.replace(/[^A-Za-z0-9가-힣_.-]/g, '');
  let out = [];
  if (ids.size) { const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).in('id', [...ids].slice(0, 20)); if (error) throw error; out = data; }
  if (!out.length && term) { // 닉네임·간편가입 아이디 (대소문자 무시)
    const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).or(`nickname.ilike.%${term}%,username.ilike.%${term}%`).limit(10);
    if (error) throw error; out = data;
  }
  if (!out.length && !raw.includes('@')) { // 영문·숫자·밑줄 외 문자가 섞인 아이디는 해시(h-…)로 저장됨 — 같은 해시로 조회
    const { data, error } = await supabase.from('profiles').select(PROFILE_COLS).eq('username', 'h-' + crypto.createHash('sha256').update(raw.toLowerCase()).digest('hex').slice(0, 32)).limit(1);
    if (error) throw error; out = data;
  }
  for (const u of out) {
    if (emails.has(u.id)) { u.email = emails.get(u.id); continue; }
    try { const r = await supabase.auth.admin.getUserById(u.id); if (r.data?.user?.email) u.email = r.data.user.email; } catch { /* 이메일은 표시용 — 실패 무시 */ }
  }
  return out;
}
function allow(socket, key, max) {
  const n = Date.now(), rl = socket.data.rl || (socket.data.rl = {}), b = rl[key] || (rl[key] = { t: n, c: 0 });
  if (n - b.t >= 1000) { b.t = n; b.c = 0; }
  return ++b.c <= max;
}

// ───────────────────────────── 12. 소켓 핸들러 ─────────────────────────────
export function attach(ioInstance) {
  io = ioInstance;
  io.use(async (socket, next) => {
    const a = socket.handshake.auth || {};
    const sess = { socket, userId: null, guest: true, name: sanitizeName(a.nickname).length >= 2 ? sanitizeName(a.nickname) : 'Guest' + randInt(1000, 9999),
      rp: 0, rankPos: null, title: null, skins: {}, career: { kd: 0, hs: 0, wr: 0, matches: 0 }, loadout: sanitizeLoadout(a.loadout), room: null, ent: null };
    if (a.token && supabase) {
      try {
        const { data, error } = await supabase.auth.getUser(a.token);
        if (error || !data?.user) return next(new Error('AUTH_INVALID'));
        sess.userId = data.user.id; sess.meta = data.user.user_metadata || {}; sess.guest = false; await loadProfile(sess);
      } catch (err) { return next(new Error(err.message || 'AUTH_FAILED')); }
    }
    socket.data.sess = sess; next();
  });

  io.on('connection', (socket) => {
    const sess = socket.data.sess;
    if (sess.userId) { const old = online.get(sess.userId); if (old && old !== socket) { old.emit('kicked', { reason: 'DUPLICATE_LOGIN' }); old.disconnect(true); } online.set(sess.userId, socket); }
    socket.emit('hello', { serverTime: clock.now(), guest: sess.guest, name: sess.name, rp: sess.rp, tier: tierLevel(sess.rp, sess.rankPos), tierLabel: tierLabel(tierLevel(sess.rp, sess.rankPos)), loadout: sess.loadout });

    const on = (ev, max, fn) => socket.on(ev, (m, ack) => {
      if (typeof m === 'function') { ack = m; m = {}; }
      if (!allow(socket, ev, max)) return;
      try { const r = fn(m && typeof m === 'object' ? m : {}, clock.now()); if (typeof ack === 'function') ack(r === undefined ? { ok: true } : r); }
      catch (err) { console.error('[evt]', ev, err); if (typeof ack === 'function') ack({ ok: false, error: 'SERVER_ERROR' }); }
    });
    const inGame = (fn) => (m, now) => { const room = sess.room, e = sess.ent; if (room && e) return fn(room, e, m, now); return { ok: false, error: 'NOT_IN_ROOM' }; };

    socket.on('time:sync', (c0, ack) => { if (typeof ack === 'function') ack({ c0, s: clock.now() }); });

    on('profile:refresh', 1, () => { if (sess.userId && supabase) loadProfile(sess).then(() => socket.emit('hello', { serverTime: clock.now(), guest: false, name: sess.name, rp: sess.rp, tier: tierLevel(sess.rp, sess.rankPos), tierLabel: tierLabel(tierLevel(sess.rp, sess.rankPos)), loadout: sess.loadout })).catch(() => {}); });

    // 빠른 매칭: {mode:'classic'|'ranked'|'tdm'|'range', teamSize:1..6, map?:'grid'|'arena'}
    on('queue:join', 3, (m, now) => {
      if (sess.room) removeHuman(sess, now);
      const mode = ['classic', 'ranked', 'tdm', 'range'].includes(m.mode) ? m.mode : 'classic';
      if (mode === 'range') { addHuman(createRange(sess, now), sess, now); return { ok: true }; }
      if (mode === 'ranked' && sess.guest) return { ok: false, error: 'LOGIN_REQUIRED' };
      const teamSize = clamp(Math.floor(fin(m.teamSize, 1)), 1, mode === 'ranked' ? 3 : 6);
      const mapReq = m.map === 'grid' || m.map === 'arena' ? m.map : null;
      let room = findRoom(mode, teamSize, mapReq, sess);
      if (!room) {
        const mapId = mapReq || (teamSize <= 2 ? 'arena' : teamSize >= 4 ? 'grid' : pick(['grid', 'arena']));
        room = createRoom({ mode, teamSize, mapId, botLevel: clamp(tierLevel(sess.rp, sess.rankPos), 0, 19) });
        addHuman(room, sess, now); startMatch(room, now);
        return { ok: true };
      }
      return addHuman(room, sess, now) ? { ok: true } : { ok: false, error: 'ROOM_FULL' };
    });
    // 사설 내전: 4자리 코드
    on('room:create', 2, (m, now) => {
      if (sess.room) removeHuman(sess, now);
      const room = createRoom({ mode: m.mode === 'tdm' ? 'tdm' : 'classic', teamSize: clamp(Math.floor(fin(m.teamSize, 1)), 1, 6), mapId: m.map === 'grid' ? 'grid' : 'arena',
        isPrivate: true, fillBots: m.fillBots !== false, botLevel: clamp(Math.floor(fin(m.botLevel, 6)), 0, 19) });
      addHuman(room, sess, now);
      return { ok: true, code: room.code };
    });
    on('room:join', 3, (m, now) => {
      const room = codes.get(String(m.code || ''));
      if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
      if (room.phase === 'ended') return { ok: false, error: 'ROOM_CLOSING' };
      if (sess.room) removeHuman(sess, now);
      return addHuman(room, sess, now) ? { ok: true, code: room.code } : { ok: false, error: 'ROOM_FULL' };
    });
    on('room:leave', 3, (m, now) => { removeHuman(sess, now); });
    on('room:team', 4, inGame((room, e, m) => {
      const t = m.team === 1 ? 1 : 0;
      if (room.phase !== 'lobby' || e.team === t) return { ok: false, error: 'NOT_ALLOWED' };
      if (teamEnts(room, t).length >= room.teamSize) return { ok: false, error: 'TEAM_FULL' };
      e.team = t; emitRoom(room, 'room:state', roomState(room));
    }));
on('room:config', 4, inGame((room, e, m) => {
      if (room.phase !== 'lobby') return { ok: false, error: 'NOT_ALLOWED' };
      if (m.mode === 'classic' || m.mode === 'tdm') room.mode = m.mode;
      if (m.map === 'grid' || m.map === 'arena') { room.mapId = m.map; room.map = roomMap(MAPS[m.map]); }
      if (Number.isFinite(m.teamSize)) { const ts = clamp(Math.floor(m.teamSize), 1, 6); if ([0, 1].every((t) => teamEnts(room, t).length <= ts)) room.teamSize = ts; }
      if (typeof m.fillBots === 'boolean') room.fillBots = m.fillBots;
      if (Number.isFinite(m.botLevel)) room.botLevel = clamp(Math.floor(m.botLevel), 0, 19);
      emitRoom(room, 'room:state', roomState(room));
    }));
    on('room:start', 2, inGame((room, e, m, now) => {
      if (room.phase !== 'lobby') return { ok: false, error: 'NOT_ALLOWED' };
      if (!room.fillBots && [0, 1].some((t) => !teamEnts(room, t).length)) return { ok: false, error: 'TEAM_EMPTY' };
      emitRoom(room, 'room:map', mapPublic(room.map)); startMatch(room, now);
    }));
    on('range:config', 4, inGame((room, e, m) => { if (room.mode === 'range') { room.rangeMoving = !!m.moving; emitRoom(room, 'range:config', { moving: room.rangeMoving }); } }));

    // 로드아웃: 구매 페이즈 / 사망 중 / 스폰 직후 / 사격장 → 즉시, 그 외 → 다음 스폰에 적용
    on('loadout:set', 6, inGame((room, e, m, now) => {
      const l = sanitizeLoadout(m); sess.loadout = l;
      const instant = room.mode === 'range' || room.phase === 'buy' || room.phase === 'lobby' || (e.alive && now - e.spawnedAt < RULES.loadoutWindowMs);
      if (!instant) { e.pending = l; return { ok: true, applied: false }; }
      e.loadout = l; e.pending = null; if (e.alive) { refill(e); emitAmmo(e); }
      emitRoom(room, 'loadout', { id: e.id, l });
      return { ok: true, applied: true };
    }));

    // 이동 입력: {s:spawnSeq, p:[x,y,z], yaw, pitch, f}
    on('input', 70, inGame((room, e, m, now) => {
      if (!e.alive || m.s !== e.spawnSeq) return;
      e.yaw = fin(m.yaw, e.yaw); e.pitch = clamp(fin(m.pitch, e.pitch), -1.55, 1.55);
      const nf = (m.f | 0) & 15; if (nf & F.ADS && !(e.flags & F.ADS)) e.adsSince = now; e.flags = nf;
      if (room.phase === 'buy' || room.phase === 'roundEnd' && false) return; // 구매 페이즈: 위치 고정
      const p = m.p; if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v))) return;
      const dt = clamp((now - e.lastMoveAt) / 1000, 0.001, 0.25), d = Math.hypot(p[0] - e.pos.x, p[2] - e.pos.z), bd = room.map.bounds;
      const w = WEAPONS[e.loadout[SLOT_KEYS[e.slot]]];
      const maxSp = Math.max(MOVE.run * (w?.move || 1), MOVE.slideV) * (now < e.dashUntil + 300 || now < e.driftUntil + 300 ? MOVE.dashMult : 1);
      const dr = e.duel ? room.map.duel.rect : null, oob = dr ? p[0] < dr.x0 || p[0] > dr.x1 || p[2] < dr.z0 || p[2] > dr.z1 : p[0] < bd.x0 || p[0] > bd.x1 || p[2] < bd.z0 || p[2] > bd.z1;
      const bad = d > maxSp * dt * 1.4 + 0.5 || oob || p[1] < -0.5 || p[1] > 40 || insideSolid(room.map, p[0], p[1] + 0.9, p[2]);
      if (bad) { if (++e.violations > 4) { e.violations = 0; e.lastMoveAt = now; socket.emit('pos:correct', { p: [e.pos.x, e.pos.y, e.pos.z], s: e.spawnSeq }); } return; }
      e.violations = Math.max(0, e.violations - 0.05); e.lastMoveAt = now;
      e.vel.x = (p[0] - e.pos.x) / dt; e.vel.z = (p[2] - e.pos.z) / dt;
      e.pos.x = p[0]; e.pos.y = p[1]; e.pos.z = p[2];
    }));
    on('weapon:switch', 15, inGame((room, e, m, now) => {
      const s = m.slot | 0; if (s < 1 || s > 4 || s === e.slot || !e.alive) return;
      e.slot = s; e.reloadUntil = 0; e.reloadKey = null; e.spray = 0; e.heat = 0;
      e.nextFireAt = Math.max(e.nextFireAt, now + (WEAPONS[e.loadout[SLOT_KEYS[s]]].equipMs || 250) - 60); emitAmmo(e);
    }));
    // 사격/근접/투척: {t:서버시각 추정, o:[x,y,z], yaw, pitch, alt}
    on('fire', 40, inGame((room, e, m, now) => {
      if (!canAct(room, e) || now < e.driftUntil || e.cast) return;
      const wid = e.loadout[SLOT_KEYS[e.slot]], w = WEAPONS[wid];
      if (w.type === 'melee') meleeAttack(room, e, w, wid, m, now);
      else if (w.type === 'throw') throwProj(room, e, wid, m, now);
      else fireGun(room, e, w, wid, m, now);
    }));
    on('reload', 5, inGame((room, e, m, now) => { if (e.alive) startReload(room, e, now); }));
    on('skill', 8, inGame((room, e, m, now) => {
      if (!canAct(room, e) || !m || typeof m !== 'object') return { ok: false };
      if (Number.isFinite(m.yaw) && Number.isFinite(m.pitch)) { e.yaw = m.yaw; e.pitch = clamp(m.pitch, -1.55, 1.55); }
      return { ok: useSkill(room, e, m.k, now, m) };
    }));

    // ───── 고객센터 / 개발자 모드 (async 핸들러). 개발자 권한은 이 소켓 연결에만 유효.
    const onA = (ev, max, fn) => socket.on(ev, async (m, ack) => {
      if (typeof m === 'function') { ack = m; m = {}; }
      const reply = (r) => { if (typeof ack === 'function') ack(r); };
      if (!allow(socket, ev, max)) return reply({ ok: false, error: 'RATE_LIMIT' });
      try { reply(await fn(m && typeof m === 'object' ? m : {}, clock.now())); }
      catch (err) { console.error('[evt]', ev, err); reply({ ok: false, error: 'SERVER_ERROR' }); }
    });
    const needUser = () => (!supabase ? 'NO_DB' : !sess.userId ? 'LOGIN_REQUIRED' : null);
    const needDev = () => (socket.data.dev === true && sess.userId ? null : 'FORBIDDEN');
    sess.ticketTimes = [];

    onA('support:list', 2, async () => {
      const e = needUser(); if (e) return { ok: false, error: e };
      const { data, error } = await supabase.from('support_tickets').select('id,message,status,created_at').eq('user_id', sess.userId).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      return { ok: true, items: data.reverse() };
    });
    // 문의 전송. 메시지가 개발자 코드와 정확히 일치하면 저장하지 않고 개발자 인증으로 처리.
    onA('support:send', 3, async (m, now) => {
      const e = needUser(); if (e) return { ok: false, error: e };
      const msg = String(m.message ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
      if (!msg) return { ok: false, error: 'EMPTY' };
      if (msg.length > 500) return { ok: false, error: 'TOO_LONG' };
      sess.ticketTimes = sess.ticketTimes.filter((t) => now - t < 3600000);
      if (sess.ticketTimes.length && now - sess.ticketTimes[sess.ticketTimes.length - 1] < 2000) return { ok: false, error: 'RATE_LIMIT' };
      if (sess.ticketTimes.length >= 20) return { ok: false, error: 'TICKET_LIMIT' };
      sess.ticketTimes.push(now);
      if (isDevCode(msg)) { socket.data.dev = true; console.log(`[admin] dev mode ON user=${sess.userId}`); return { ok: true, dev: true }; }
      const { data, error } = await supabase.from('support_tickets').insert({ user_id: sess.userId, nickname: sess.name, message: msg }).select('id,message,status,created_at').single();
      if (error) throw error;
      return { ok: true, item: data };
    });
    onA('admin:exit', 2, async () => { socket.data.dev = false; return { ok: true }; });
    onA('admin:tickets', 4, async () => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const { data, error } = await supabase.from('support_tickets').select('id,user_id,nickname,message,status,created_at').order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return { ok: true, items: data };
    });
    onA('admin:ticket', 10, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const id = Number(m.id); if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'BAD_REQUEST' };
      const q = supabase.from('support_tickets');
      const r = m.action === 'delete' ? await q.delete().eq('id', id) : m.action === 'done' || m.action === 'open' ? await q.update({ status: m.action }).eq('id', id) : { error: { message: 'BAD_ACTION' } };
      if (r.error) return { ok: false, error: 'BAD_REQUEST' };
      console.log(`[admin] ticket ${m.action} id=${id} by=${sess.userId}`);
      return { ok: true };
    });
    onA('admin:search', 6, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      return { ok: true, items: await findAccounts(m.q ?? m.query ?? m.id) };
    });
    // 크레딧 증감: {id:uuid, delta:int(±)} → DB 원자 갱신, 접속 중이면 즉시 클라이언트 반영
    onA('admin:credits', 6, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const delta = Number(m.delta), id = String(m.id ?? '').toLowerCase();
      if (!UUID_RE.test(id) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1e9) return { ok: false, error: 'BAD_REQUEST' };
      const { data, error } = await supabase.rpc('admin_adjust_credits', { p_user: id, p_delta: delta });
      if (error) return { ok: false, error: /USER_NOT_FOUND/.test(error.message) ? 'USER_NOT_FOUND' : 'SERVER_ERROR' };
      console.log(`[admin] credits ${delta >= 0 ? '+' : ''}${delta} target=${id} ${data.before}->${data.after} by=${sess.userId}`);
      const t = online.get(id); if (t) t.emit('credits:update', { credits: data.after });
      return { ok: true, before: data.before, after: data.after };
    });

    // ───── 계정 스킨 관리 (개발자 모드 전용 — needDev 로 DEV_SECRET_CODE 인증된 소켓만, DB 는 service_role 클라이언트)
    const SKIN_ID_RE = /^[a-z0-9_]{3,64}$/;
    const ownedSkins = async (id) => {
      const { data, error } = await supabase.from('user_skins').select('skin_id,weapon_id,equipped').eq('user_id', id);
      if (error) throw error;
      return data;
    };
    // 접속 중인 대상: 보관함 갱신 이벤트 + 매치 입장 시 쓰이는 장착 스킨 캐시 재계산
    const pushSkins = async (id) => {
      const t = online.get(id); if (!t) return false;
      const rows = await ownedSkins(id);
      if (t.data.sess) t.data.sess.skins = Object.fromEntries(rows.filter((r) => r.equipped).map((r) => [r.weapon_id, r.skin_id]));
      t.emit('skins:update', { skins: rows.map((r) => r.skin_id) });
      return true;
    };
    // 대상 조회: {q:닉네임|UUID} → 기본 정보 + 보유 스킨 ID 목록 (닉네임 정확히 일치 우선)
    const SKIN_QUERY_MSG = { FORBIDDEN: '권한이 없습니다. 개발자 모드를 다시 인증해 주세요.', EMPTY_QUERY: '검색어(닉네임·이메일·UUID)를 입력해 주세요.', USER_NOT_FOUND: '해당 유저를 찾을 수 없습니다.', SERVER_ERROR: '서버 오류로 조회하지 못했습니다.' };
    const skinFail = (error) => ({ ok: false, error, message: SKIN_QUERY_MSG[error] || error, user: null, ownedSkins: [], skins: [] });
    onA('admin:skins', 8, async (m) => {
      const e = needDev(); if (e) return skinFail(e);
      const raw = String(m.q ?? m.query ?? m.id ?? m.nickname ?? m.email ?? m.userId ?? '').trim();
      if (!raw) return skinFail('EMPTY_QUERY');
      try {
        const found = await findAccounts(raw); if (!found.length) return skinFail('USER_NOT_FOUND');
        const lc = raw.toLowerCase(), user = found.find((u) => u.id === lc || (u.email || '').toLowerCase() === lc || u.nickname.toLowerCase() === lc || (u.username || '').toLowerCase() === lc) || found[0];
        const skins = (await ownedSkins(user.id)).map((r) => r.skin_id);
        return { ok: true, message: `조회 완료: ${user.nickname} (보유 스킨 ${skins.length}개)`, user, userId: user.id, nickname: user.nickname, ownedSkins: skins, skins, others: found.length - 1, online: online.has(user.id) };
      } catch (err) { console.error('[admin:skins]', err); return skinFail('SERVER_ERROR'); }
    });
    // 지급: {id, skinId | 'ALL'} — 카탈로그에 있는(active) 스킨만, 중복 없이 추가
    onA('admin:skin:grant', 8, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const id = String(m.id ?? m.userId ?? '').trim().toLowerCase(), skinId = String(m.skinId ?? m.skin ?? '').trim();
      if (!UUID_RE.test(id) || (skinId !== 'ALL' && !SKIN_ID_RE.test(skinId))) return { ok: false, error: 'BAD_REQUEST' };
      const pr = await supabase.from('profiles').select('id').eq('id', id).maybeSingle(); if (pr.error) throw pr.error;
      if (!pr.data) return { ok: false, error: 'USER_NOT_FOUND' };
      let cat = supabase.from('skin_catalog').select('skin_id,weapon_id').eq('active', true);
      if (skinId !== 'ALL') cat = cat.eq('skin_id', skinId);
      const { data: items, error: ce } = await cat; if (ce) throw ce;
      if (!items.length) return { ok: false, error: 'SKIN_NOT_FOUND' };
      const have = new Set((await ownedSkins(id)).map((r) => r.skin_id));
      const rows = items.filter((s) => !have.has(s.skin_id)).map((s) => ({ user_id: id, skin_id: s.skin_id, weapon_id: s.weapon_id, source: 'reward' }));
      if (rows.length) { const { error } = await supabase.from('user_skins').upsert(rows, { onConflict: 'user_id,skin_id', ignoreDuplicates: true }); if (error) throw error; }
      console.log(`[admin] skin grant ${skinId} added=${rows.length} target=${id} by=${sess.userId}`);
      const pushed = await pushSkins(id);
      return { ok: true, added: rows.length, total: items.length, skins: (await ownedSkins(id)).map((r) => r.skin_id), pushed };
    });
    // 회수: {id, skinId} — 장착 중이면 행 삭제로 장착도 함께 해제
    onA('admin:skin:revoke', 8, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const id = String(m.id ?? m.userId ?? '').trim().toLowerCase(), skinId = String(m.skinId ?? m.skin ?? '').trim();
      if (!UUID_RE.test(id) || !SKIN_ID_RE.test(skinId)) return { ok: false, error: 'BAD_REQUEST' };
      const { data, error } = await supabase.from('user_skins').delete().eq('user_id', id).eq('skin_id', skinId).select('skin_id');
      if (error) throw error;
      if (!data.length) return { ok: false, error: 'SKIN_NOT_OWNED' };
      console.log(`[admin] skin revoke ${skinId} target=${id} by=${sess.userId}`);
      const pushed = await pushSkins(id);
      return { ok: true, skins: (await ownedSkins(id)).map((r) => r.skin_id), pushed };
    });

    // ───── 계정 조회 확장: 랭크 점수 설정 / 기간 정지·해제
    const refreshOnline = async (id) => { const t = online.get(id); if (!t?.data.sess) return false; await loadProfile(t.data.sess); const x = t.data.sess; t.emit('hello', { serverTime: clock.now(), guest: false, name: x.name, rp: x.rp, tier: tierLevel(x.rp, x.rankPos), tierLabel: tierLabel(tierLevel(x.rp, x.rankPos)), loadout: x.loadout }); return true; };
    onA('admin:rank', 8, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const id = String(m.id ?? '').trim().toLowerCase(), rp = Number(m.rp);
      if (!UUID_RE.test(id) || !Number.isInteger(rp) || rp < 0 || rp > 1000000) return { ok: false, error: 'BAD_REQUEST', message: '랭크 점수는 0 ~ 1,000,000 사이 정수여야 합니다.' };
      const cur = await supabase.from('profiles').select('rank_points,peak_rank_points').eq('id', id).maybeSingle(); if (cur.error) throw cur.error;
      if (!cur.data) return { ok: false, error: 'USER_NOT_FOUND' };
      const { error } = await supabase.from('profiles').update({ rank_points: rp, peak_rank_points: Math.max(cur.data.peak_rank_points ?? 0, rp) }).eq('id', id); if (error) throw error;
      console.log(`[admin] rank ${cur.data.rank_points}->${rp} target=${id} by=${sess.userId}`);
      let pushed = false; try { pushed = await refreshOnline(id); } catch (err) { console.error('[admin:rank refresh]', err.message); }
      return { ok: true, before: cur.data.rank_points, after: rp, pushed };
    });
    // 정지: {id, minutes:int(>0) , reason?} 또는 {id, minutes:0} 해제
    onA('admin:ban', 6, async (m) => {
      const e = needDev(); if (e) return { ok: false, error: e };
      const id = String(m.id ?? '').trim().toLowerCase(), minutes = Number(m.minutes);
      if (!UUID_RE.test(id) || !Number.isInteger(minutes) || minutes < 0 || minutes > 525600 * 10) return { ok: false, error: 'BAD_REQUEST' };
      if (id === sess.userId) return { ok: false, error: 'SELF_BAN', message: '본인 계정은 정지할 수 없습니다.' };
      const until = minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null, reason = String(m.reason ?? '').replace(/[ -]/g, '').trim().slice(0, 200) || null;
      const { data, error } = await supabase.from('profiles').update({ banned_until: until, ban_reason: until ? reason : null }).eq('id', id).select('id');
      if (error) { if (/banned_until|ban_reason/.test(error.message)) return { ok: false, error: 'DB_MIGRATION_REQUIRED', message: 'DB 에 정지 컬럼이 없습니다. npm run db:push 로 supabase_account_admin.sql 을 적용하세요.' }; throw error; }
      if (!data.length) return { ok: false, error: 'USER_NOT_FOUND' };
      BAN_COLS = true;
      console.log(`[admin] ${until ? `ban until ${until}` : 'unban'} target=${id} by=${sess.userId} reason=${reason ?? ''}`);
      const t = online.get(id); let kicked = false;
      if (until && t) { t.emit('kicked', { reason: 'BANNED:' + until }); t.disconnect(true); kicked = true; }
      return { ok: true, banned_until: until, ban_reason: until ? reason : null, kicked };
    });

    socket.on('disconnect', () => {
      try { removeHuman(sess, clock.now()); } catch (err) { console.error('[disconnect]', err); }
      if (sess.userId && online.get(sess.userId) === socket) online.delete(sess.userId);
    });
  });
}

// ───────────────────────────── 13. 부트스트랩 ─────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 이메일 없는 간편가입: 아이디+비번+닉네임만으로 계정 생성 (확인 메일을 보내지 않도록 admin API + email_confirm)
  const signupHits = new Map();
  const signupHandler = (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    const out = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') return out(405, { ok: false, error: 'METHOD' });
    if (!supabase) return out(503, { ok: false, error: 'NOT_CONFIGURED' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
    const hits = (signupHits.get(ip) || []).filter((t) => now - t < 3600e3); if (hits.length >= 20) return out(429, { ok: false, error: 'RATE_LIMIT' });
    let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 2000) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(raw || '{}'), id = String(b.id ?? '').trim().toLowerCase(), pw = String(b.password ?? ''), nick = String(b.nickname ?? '').trim();
        if ([...id].length < 4 || [...id].length > 16 || /[\s\p{C}]/u.test(id)) return out(400, { ok: false, error: 'INVALID_ID' });
        if (pw.length < 6 || pw.length > 72) return out(400, { ok: false, error: 'INVALID_PASSWORD' });
        if (!/^[A-Za-z0-9가-힣_]{2,16}$/.test(nick)) return out(400, { ok: false, error: 'INVALID_NICKNAME' });
        const email = (/^[a-z0-9_]+$/.test(id) ? id : 'h-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 32)) + '@game.local';
        const { data: taken } = await supabase.from('profiles').select('id').ilike('nickname', nick).maybeSingle();
        if (taken) return out(409, { ok: false, error: 'NICKNAME_TAKEN' });
        signupHits.set(ip, [...hits, now]);
        const { error } = await supabase.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { nickname: nick } });
        if (error) { const dup = /already|registered|exists/i.test(error.message); return out(dup ? 409 : 500, { ok: false, error: dup ? 'ID_TAKEN' : 'SERVER_ERROR', message: error.message }); }
        out(200, { ok: true });
      } catch (err) { console.error('[auth/signup]', err); out(500, { ok: false, error: 'SERVER_ERROR' }); }
    });
  };
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: io ? io.engine.clientsCount : 0, supabase: !!supabase }));
    } else if (req.url === '/auth/signup') signupHandler(req, res);
    else { res.writeHead(404); res.end(); }
  });
  attach(new Server(httpServer, {
    cors: { origin: ORIGINS.includes('*') ? true : ORIGINS, methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'], perMessageDeflate: false, pingInterval: 10000, pingTimeout: 8000, maxHttpBufferSize: 1e4,
  }));
  setInterval(() => tickAll(), 1000 / RULES.tickHz);
  httpServer.listen(PORT, () => console.log(`[gridstrike] :${PORT} supabase=${!!supabase} origins=${ORIGINS.join(',')}`));
  const shutdown = () => { io.emit('server:shutdown'); io.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}