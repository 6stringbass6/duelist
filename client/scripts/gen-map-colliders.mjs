// =====================================================================
// 메시 맵(FBX/GLB) → 서버용 AABB 충돌 박스 + 안전 스폰 좌표 생성기
// 실행: node client/scripts/gen-map-colliders.mjs  →  server/maps/<id>.json
// 1) 스케일·회전·바닥(y=0) 정규화  2) 삼각형 표면 복셀화(0.25m)  3) 닫힌 내부 채움 + 탐욕 병합으로 박스화
// 4) 지상 자유 셀 중 최대 연결 영역에서 양 끝(±z)에 팀별 스폰 6개씩 선정
// =====================================================================
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, THREE } from './loadModel.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAPS = [
  // 킬 하우스: cm 단위 원본(약 3773×1918) → ×0.015 ≈ 29×57m, 벽 높이 ≈3m. 긴 축을 z로 회전.
  { id: 'killhouse', name: '킬 하우스', file: 'killhouse.fbx', scale: 0.015, rotY: Math.PI / 2 },
  // 물류 창고: 원본 8.5×16.4 → ×3.5 ≈ 30×57m, 상자 ≈1.75m, 벽 ≈7m.
  { id: 'warehouse', name: '물류 창고', file: 'warehouse.glb', scale: 3.5, rotY: 0 },
];
const CS = 0.25, VH = 0.25, GROUND_SKIP = 0.12, MAX_H = 24, PLAYER_H = 1.8, FALL_Y = -0.5;
const r2 = (x) => Math.round(x * 100) / 100;

async function build(def) {
  const root = await loadModel(resolve(ROOT, 'client/public/models/maps', def.file));
  root.updateMatrixWorld(true);
  const pre = new THREE.Matrix4().makeRotationY(def.rotY).multiply(new THREE.Matrix4().makeScale(def.scale, def.scale, def.scale));

  // 1) 모든 삼각형을 회전·스케일 적용 좌표로 수집
  const tris = [], v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = new THREE.Matrix4().multiplyMatrices(pre, o.matrixWorld), pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count, P = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
    for (let i = 0; i < n; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      tris.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2], P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    }
  });
  const T = new Float32Array(tris);

  // 2) 바닥 높이 = 면적 가중 수평면 히스토그램(0.1m 버킷)에서 넓은 면 중 최저 높이
  const hist = new Map();
  let mnX = Infinity, mxX = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (let i = 0; i < T.length; i += 9) {
    for (let k = 0; k < 9; k += 3) { mnX = Math.min(mnX, T[i + k]); mxX = Math.max(mxX, T[i + k]); mnZ = Math.min(mnZ, T[i + k + 2]); mxZ = Math.max(mxZ, T[i + k + 2]); }
    const ux = T[i + 3] - T[i], uy = T[i + 4] - T[i + 1], uz = T[i + 5] - T[i + 2], wx = T[i + 6] - T[i], wy = T[i + 7] - T[i + 1], wz = T[i + 8] - T[i + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny) / len < 0.95) continue;
    const key = Math.round(((T[i + 1] + T[i + 4] + T[i + 7]) / 3) * 10);
    hist.set(key, (hist.get(key) || 0) + len / 2);
  }
  const maxA = Math.max(...hist.values());
  const groundKey = Math.min(...[...hist].filter(([, a]) => a >= maxA * 0.25).map(([k]) => k));
  const offset = [-(mnX + mxX) / 2, -groundKey / 10, -(mnZ + mxZ) / 2];
  for (let i = 0; i < T.length; i += 3) { T[i] += offset[0]; T[i + 1] += offset[1]; T[i + 2] += offset[2]; }
  const hx = (mxX - mnX) / 2, hz = (mxZ - mnZ) / 2;
  const bounds = { x0: -Math.ceil(hx), x1: Math.ceil(hx), z0: -Math.ceil(hz), z1: Math.ceil(hz) };

  // 3) 표면 복셀화 (바닥면 자체는 서버의 y=0 평면이 담당하므로 제외)
  const nx = Math.ceil((bounds.x1 - bounds.x0) / CS), nz = Math.ceil((bounds.z1 - bounds.z0) / CS), ny = Math.ceil(MAX_H / VH);
  const occ = new Uint8Array(nx * nz * ny), at = (i, j, k) => (k * nz + j) * nx + i;
  const mark = (x, y, z) => {
    if (y < GROUND_SKIP || y >= MAX_H) return;
    const i = Math.floor((x - bounds.x0) / CS), j = Math.floor((z - bounds.z0) / CS), k = Math.floor(y / VH);
    if (i >= 0 && j >= 0 && i < nx && j < nz) occ[at(i, j, k)] = 1;
  };
  const step = CS * 0.45;
  for (let i = 0; i < T.length; i += 9) {
    const ax = T[i], ay = T[i + 1], az = T[i + 2], bx = T[i + 3], by = T[i + 4], bz = T[i + 5], cx = T[i + 6], cy = T[i + 7], cz = T[i + 8];
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
    const n = Math.max(1, Math.ceil(e / step));
    for (let s = 0; s <= n; s++) for (let t = 0; t <= n - s; t++) {
      const u = s / n, w = t / n, r = 1 - u - w;
      mark(ax * r + bx * u + cx * w, ay * r + by * u + cy * w, az * r + bz * u + cz * w);
    }
  }

  // 3b) 외부 플러드필: 바깥(상단·측면)에서 도달 불가능한 빈 공간 = 닫힌 소품 내부 → 채움(박스 수 감소)
  const ext = new Uint8Array(occ.length), fq = [];
  const seed = (i, j, k) => { const c = at(i, j, k); if (!occ[c] && !ext[c]) { ext[c] = 1; fq.push(c); } };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) seed(i, j, ny - 1);
  for (let k = 0; k < ny; k++) { for (let i = 0; i < nx; i++) { seed(i, 0, k); seed(i, nz - 1, k); } for (let j = 0; j < nz; j++) { seed(0, j, k); seed(nx - 1, j, k); } }
  for (let h = 0; h < fq.length; h++) {
    const c = fq[h], i = c % nx, j = ((c / nx) | 0) % nz, k = (c / (nx * nz)) | 0;
    if (i > 0) seed(i - 1, j, k); if (i < nx - 1) seed(i + 1, j, k);
    if (j > 0) seed(i, j - 1, k); if (j < nz - 1) seed(i, j + 1, k);
    if (k > 0) seed(i, j, k - 1); if (k < ny - 1) seed(i, j, k + 1);
  }
  for (let c = 0; c < occ.length; c++) if (!ext[c]) occ[c] = 1;

  // 4) 탐욕 병합 (x → z → y)
  const used = new Uint8Array(occ.length), boxes = [];
  const free = (i, j, k) => occ[at(i, j, k)] && !used[at(i, j, k)];
  for (let k = 0; k < ny; k++) for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (!free(i, j, k)) continue;
    let i1 = i; while (i1 + 1 < nx && free(i1 + 1, j, k)) i1++;
    const rowOk = (jj, kk) => { for (let a = i; a <= i1; a++) if (!free(a, jj, kk)) return false; return true; };
    let j1 = j; while (j1 + 1 < nz && rowOk(j1 + 1, k)) j1++;
    const slabOk = (kk) => { for (let b = j; b <= j1; b++) if (!rowOk(b, kk)) return false; return true; };
    let k1 = k; while (k1 + 1 < ny && slabOk(k1 + 1)) k1++;
    for (let c = k; c <= k1; c++) for (let b = j; b <= j1; b++) for (let a = i; a <= i1; a++) used[at(a, b, c)] = 1;
    boxes.push([r2(bounds.x0 + i * CS), r2(k * VH), r2(bounds.z0 + j * CS), r2(bounds.x0 + (i1 + 1) * CS), r2((k1 + 1) * VH), r2(bounds.z0 + (j1 + 1) * CS), 'mesh']);
  }

  // 5) 지상 보행 가능 셀(높이 0~1.8m 비어 있음) → 여유 반경 → 최대 연결 영역 → 양 끝 스폰
  const headK = Math.ceil(PLAYER_H / VH), walk = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let ok = 1; for (let k = 0; k < headK; k++) if (occ[at(i, j, k)]) { ok = 0; break; }
    walk[j * nx + i] = ok;
  }
  // 여유 반경: 장애물·맵 경계까지 체비셰프 거리(셀)
  const clear = new Int32Array(nx * nz).fill(1e9), q = [];
  for (let c = 0; c < nx * nz; c++) if (!walk[c]) { clear[c] = 0; q.push(c); }
  for (let h = 0; h < q.length; h++) {
    const c = q[h], i = c % nx, j = (c / nx) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const d = b * nx + a; if (clear[d] > clear[c] + 1) { clear[d] = clear[c] + 1; q.push(d); }
    }
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) clear[j * nx + i] = Math.min(clear[j * nx + i], i + 1, j + 1, nx - i, nz - j);
  // 최대 연결 영역(밀폐 공간 배제)
  const comp = new Int32Array(nx * nz).fill(-1); let best = -1, bestN = 0, cid = 0;
  for (let s = 0; s < nx * nz; s++) {
    if (!walk[s] || comp[s] >= 0 || clear[s] < 2) continue;
    const st = [s]; comp[s] = cid; let cnt = 0;
    while (st.length) {
      const c = st.pop(); cnt++; const i = c % nx, j = (c / nx) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const d = b * nx + a; if (walk[d] && comp[d] < 0 && clear[d] >= 2) { comp[d] = cid; st.push(d); }
      }
    }
    if (cnt > bestN) { bestN = cnt; best = cid; } cid++;
  }
  const need = Math.ceil(1.0 / CS); // 반경 1m 이상 확보
  const cand = [];
  for (let c = 0; c < nx * nz; c++) if (comp[c] === best && clear[c] >= need) cand.push({ x: bounds.x0 + ((c % nx) + 0.5) * CS, z: bounds.z0 + (((c / nx) | 0) + 0.5) * CS, cl: clear[c] });
  const pickTeam = (sign) => {
    // 끝단(±z)에 가까울수록, 중앙 x에 가까울수록, 여유 반경이 클수록 우선. 상호 간격 ≥ 2.2m
    const score = (p) => sign * p.z * 2 - Math.abs(p.x) * 0.35 + Math.min(p.cl, 10) * CS;
    const sorted = [...cand].sort((a, b) => score(b) - score(a)), out = [];
    for (const p of sorted) { if (out.every((o) => Math.hypot(o.x - p.x, o.z - p.z) >= 2.2)) out.push(p); if (out.length === 6) break; }
    return out.map((p) => ({ x: r2(p.x), y: 0, z: r2(p.z), yaw: sign < 0 ? Math.PI : 0 })); // 상대 진영(중앙)을 바라봄
  };
  const spawns = [pickTeam(-1), pickTeam(1)];

  const out = { id: def.id, name: def.name, model: { url: `models/maps/${def.file}`, scale: def.scale, rotY: def.rotY, offset: offset.map((n) => Math.round(n * 1e4) / 1e4) }, bounds, wallH: 12, fallY: FALL_Y, spawns, boxes };
  const file = resolve(ROOT, 'server/maps', `${def.id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  console.log(`${def.id}: tris=${T.length / 9} bounds=${JSON.stringify(bounds)} ground=${groundKey / 10} boxes=${boxes.length} walkComp=${bestN} cand=${cand.length}`);
  console.log('  spawns', JSON.stringify(spawns.map((l) => l.map((s) => [s.x, s.z]))));
}

for (const def of MAPS) await build(def);
