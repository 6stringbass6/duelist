// =====================================================================
// 3D 타격 이펙트: 피격 스파크 · 헤드샷 황금 파편 · 벽/바닥 탄흔(데칼) · 먼지 연기
// 전부 오브젝트 풀링 — 런타임 할당/해제 없음.
//  · 파티클: 고정 크기 THREE.Points 2개(가산 스파크 / 알파 먼지), 링 버퍼로 슬롯 재사용 → 드로콜 2회
//  · 탄흔  : InstancedMesh 1개, 링 버퍼로 가장 오래된 탄흔부터 덮어씀 → 드로콜 1회
// =====================================================================
import * as THREE from 'three';

export type FxQuality = 'off' | 'low' | 'high';

const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uViewH;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(180.0, aSize * uViewH * projectionMatrix[1][1] * 0.5 / max(0.05, -mv.z));
}`;
const FRAG = /* glsl */ `
uniform float uSoft;
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vColor.a <= 0.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * pow(1.0 - d, uSoft));
  #include <colorspace_fragment>
}`;

const FLOOR_Y = 0.02;
const view = new THREE.Vector2();

/** 고정 크기 파티클 풀 (링 버퍼). 죽은 파티클은 크기 0 으로 남아 GPU 에서 버려진다. */
class ParticlePool {
  readonly points: THREE.Points;
  private readonly pos: Float32Array; private readonly col: Float32Array; private readonly size: Float32Array;
  private readonly vel: Float32Array; private readonly life: Float32Array; private readonly max: Float32Array;
  private readonly s0: Float32Array; private readonly s1: Float32Array; private readonly a0: Float32Array;
  private readonly grav: Float32Array; private readonly drag: Float32Array;
  private readonly aPos: THREE.BufferAttribute; private readonly aCol: THREE.BufferAttribute; private readonly aSize: THREE.BufferAttribute;
  private cursor = 0; private live = 0;

  constructor(private readonly n: number, additive: boolean, soft: number) {
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 4); this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n);
    this.s0 = new Float32Array(n); this.s1 = new Float32Array(n); this.a0 = new Float32Array(n);
    this.grav = new Float32Array(n); this.drag = new Float32Array(n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', (this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)));
    geo.setAttribute('aColor', (this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage)));
    geo.setAttribute('aSize', (this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage)));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uViewH: { value: 800 }, uSoft: { value: soft } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false; this.points.renderOrder = 5; this.points.visible = false;
    this.points.onBeforeRender = (renderer) => { mat.uniforms.uViewH.value = renderer.getDrawingBufferSize(view).y; };
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, c: THREE.Color, alpha: number, grav: number, drag: number): void {
    const i = this.cursor, i3 = i * 3, i4 = i * 4; this.cursor = (i + 1) % this.n;
    if (this.life[i] <= 0) this.live++;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha; this.grav[i] = grav; this.drag[i] = drag;
    this.col[i4] = c.r; this.col[i4 + 1] = c.g; this.col[i4 + 2] = c.b; this.col[i4 + 3] = alpha; this.size[i] = s0;
    this.points.visible = true;
  }
  update(dt: number): void {
    if (!this.live) return;
    const { pos, vel, life, max, size, col } = this;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) continue;
      const i3 = i * 3;
      if ((life[i] -= dt) <= 0) { life[i] = 0; size[i] = 0; col[i * 4 + 3] = 0; this.live--; continue; }
      const k = life[i] / max[i], f = Math.exp(-this.drag[i] * dt);
      vel[i3] *= f; vel[i3 + 1] = vel[i3 + 1] * f - this.grav[i] * dt; vel[i3 + 2] *= f;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      if (pos[i3 + 1] < FLOOR_Y && vel[i3 + 1] < 0) { pos[i3 + 1] = FLOOR_Y; vel[i3 + 1] *= -0.35; vel[i3] *= 0.6; vel[i3 + 2] *= 0.6; } // 바닥 튕김
      size[i] = this.s1[i] + (this.s0[i] - this.s1[i]) * k;
      col[i * 4 + 3] = this.a0[i] * Math.min(1, k * 1.8);
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
    if (!this.live) this.points.visible = false;
  }
  clear(): void {
    this.life.fill(0); this.size.fill(0); this.live = 0; this.cursor = 0;
    this.aSize.needsUpdate = true; this.points.visible = false;
  }
  dispose(): void { this.points.removeFromParent(); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

/** 탄흔 텍스처: 중심이 검게 팬 구멍 + 그을음 + 방사형 균열 */
function decalTexture(): THREE.CanvasTexture {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, h = S / 2;
  const soot = g.createRadialGradient(h, h, 2, h, h, h);
  soot.addColorStop(0, 'rgba(0,0,0,.95)'); soot.addColorStop(0.22, 'rgba(8,8,10,.9)'); soot.addColorStop(0.42, 'rgba(24,22,20,.5)'); soot.addColorStop(1, 'rgba(30,28,26,0)');
  g.fillStyle = soot; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.2; g.lineCap = 'round';
  for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2 + 0.4 * Math.sin(i * 12.9), r = h * (0.45 + 0.4 * Math.abs(Math.sin(i * 7.3))); g.beginPath(); g.moveTo(h + Math.cos(a) * 5, h + Math.sin(a) * 5); g.lineTo(h + Math.cos(a) * r, h + Math.sin(a) * r); g.stroke(); }
  g.fillStyle = 'rgba(190,190,200,.35)'; g.beginPath(); g.arc(h - 2, h - 2, 3.2, 0, 7); g.fill(); // 깎인 면 하이라이트
  g.fillStyle = '#000'; g.beginPath(); g.arc(h, h, 3.4, 0, 7); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const DECAL_LIFE = 14, DECAL_FADE = 1.5;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class ImpactFx {
  quality: FxQuality = 'low';
  private readonly sparks = new ParticlePool(640, true, 0.7);
  private readonly dust = new ParticlePool(192, false, 1.5);
  private readonly decals: THREE.InstancedMesh;
  private readonly decalN = 128;
  private readonly decalLife = new Float32Array(128);
  private readonly decalScale = new Float32Array(128);
  private decalCursor = 0; private decalLive = 0;
  // 재사용 임시 객체 (프레임당 할당 없음)
  private readonly m4 = new THREE.Matrix4(); private readonly q = new THREE.Quaternion(); private readonly q2 = new THREE.Quaternion();
  private readonly v = new THREE.Vector3(); private readonly n = new THREE.Vector3(); private readonly s = new THREE.Vector3();
  private readonly cHot = new THREE.Color(0xfff1c4); private readonly cSpark = new THREE.Color(0xff9a3c); private readonly cHit = new THREE.Color(0xff5a4a);
  private readonly cGold = new THREE.Color(0xffc21f); private readonly cGoldHi = new THREE.Color(0xfff3b0); private readonly cAmber = new THREE.Color(0xff8a00);
  private readonly cDust = new THREE.Color(0xb9b1a6); private readonly cChip = new THREE.Color(0x8d8880);

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshBasicMaterial({ map: decalTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, this.decalN);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.decals.frustumCulled = false; this.decals.renderOrder = 1; this.decals.visible = false;
    this.m4.makeScale(0, 0, 0); for (let i = 0; i < this.decalN; i++) this.decals.setMatrixAt(i, this.m4);
    scene.add(this.decals, this.dust.points, this.sparks.points);
  }

  private burst(pool: ParticlePool, count: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, speed: number, spread: number,
    life: number, s0: number, s1: number, c: THREE.Color, alpha: number, grav: number, drag: number): void {
    for (let i = 0; i < count; i++) {
      const sp = speed * (0.35 + Math.random() * 0.65);
      pool.emit(x, y, z, nx * sp + (Math.random() - 0.5) * spread, ny * sp + (Math.random() - 0.5) * spread, nz * sp + (Math.random() - 0.5) * spread,
        life * (0.55 + Math.random() * 0.45), s0 * (0.6 + Math.random() * 0.4), s1, c, alpha, grav, drag);
    }
  }
  private count(high: number, low: number, lite: boolean): number { const c = this.quality === 'high' ? high : low; return lite ? Math.max(1, Math.round(c * 0.4)) : c; }

  /** 적 피격: 붉은빛 섞인 스파크. (nx,ny,nz) = 튀는 방향(사수 쪽) */
  hitSpark(x: number, y: number, z: number, nx: number, ny: number, nz: number, lite = false): void {
    if (this.quality === 'off') return;
    this.burst(this.sparks, this.count(9, 5, lite), x, y, z, nx, ny, nz, 5.5, 4.2, 0.3, 0.07, 0.012, this.cSpark, 1, 11, 2.2);
    this.burst(this.sparks, this.count(5, 3, lite), x, y, z, nx, ny, nz, 3.2, 3, 0.24, 0.085, 0.02, this.cHit, 0.95, 6, 3);
    this.sparks.emit(x, y, z, 0, 0, 0, 0.09, 0.3, 0.55, this.cHot, 0.7, 0, 0); // 타격 섬광
  }
  /** 헤드샷: 황금빛 파편이 사방으로 터지고 반짝이며 떨어진다 */
  headShards(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    if (this.quality === 'off') return;
    this.burst(this.sparks, this.count(20, 11, false), x, y, z, nx * 0.5, ny * 0.5 + 0.5, nz * 0.5, 6.5, 6.5, 0.7, 0.1, 0.02, this.cGold, 1, 12, 1.6);
    this.burst(this.sparks, this.count(10, 6, false), x, y, z, nx, ny + 0.3, nz, 3.5, 4, 0.5, 0.075, 0.015, this.cGoldHi, 1, 7, 2.4);
    this.burst(this.sparks, this.count(6, 3, false), x, y, z, 0, 1, 0, 2.2, 2.4, 0.9, 0.06, 0.01, this.cAmber, 0.9, 3, 1.2);
    this.sparks.emit(x, y, z, 0, 0, 0, 0.13, 0.5, 1.15, this.cGoldHi, 0.85, 0, 0); // 황금 섬광
    this.sparks.emit(x, y, z, 0, 0, 0, 0.22, 0.22, 0.75, this.cGold, 0.5, 0, 0);
  }
  /** 벽/바닥 피격: 탄흔 + 먼지 연기 + 파편 불똥. (nx,ny,nz) = 표면 법선 */
  wallImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, decal: boolean, lite = false): void {
    if (this.quality === 'off') return;
    const px = x + nx * 0.03, py = y + ny * 0.03, pz = z + nz * 0.03;
    this.burst(this.sparks, this.count(5, 3, lite), px, py, pz, nx, ny, nz, 3.6, 2.6, 0.22, 0.05, 0.01, this.cHot, 1, 10, 2.5);
    this.burst(this.dust, this.count(3, 2, lite), px, py, pz, nx, ny + 0.25, nz, 1.1, 0.7, 0.85, 0.16, 0.62, this.cDust, 0.34, -0.5, 3.2);
    if (!lite) this.burst(this.dust, this.count(3, 1, false), px, py, pz, nx, ny, nz, 2.6, 2.2, 0.5, 0.045, 0.03, this.cChip, 0.9, 9.8, 1.4); // 부스러기
    if (decal) this.addDecal(x, y, z, nx, ny, nz);
  }
  private addDecal(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    const i = this.decalCursor; this.decalCursor = (i + 1) % this.decalN;
    if (this.decalLife[i] <= 0) this.decalLive++;
    const sc = 0.2 + Math.random() * 0.1; this.decalLife[i] = DECAL_LIFE; this.decalScale[i] = sc;
    this.n.set(nx, ny, nz); this.q.setFromUnitVectors(Z_AXIS, this.n).multiply(this.q2.setFromAxisAngle(Z_AXIS, Math.random() * Math.PI * 2));
    this.decals.setMatrixAt(i, this.m4.compose(this.v.set(x + nx * 0.012, y + ny * 0.012, z + nz * 0.012), this.q, this.s.set(sc, sc, 1)));
    this.decals.instanceMatrix.needsUpdate = true; this.decals.visible = true;
  }

  update(dt: number): void {
    this.sparks.update(dt); this.dust.update(dt);
    if (!this.decalLive) return;
    let dirty = false;
    for (let i = 0; i < this.decalN; i++) {
      if (this.decalLife[i] <= 0) continue;
      const l = (this.decalLife[i] -= dt);
      if (l > DECAL_FADE) continue;
      // 수명 끝: 서서히 줄어들며 사라짐 (인스턴스별 알파 대신 스케일 페이드)
      this.decals.getMatrixAt(i, this.m4); this.m4.decompose(this.v, this.q, this.s);
      const sc = l <= 0 ? 0 : this.decalScale[i] * (l / DECAL_FADE);
      this.decals.setMatrixAt(i, this.m4.compose(this.v, this.q, this.s.set(sc, sc, 1))); dirty = true;
      if (l <= 0) { this.decalLife[i] = 0; this.decalLive--; }
    }
    if (dirty) this.decals.instanceMatrix.needsUpdate = true;
    if (!this.decalLive) this.decals.visible = false;
  }
  /** 라운드 전환/방 퇴장: 모든 이펙트를 풀로 되돌린다 */
  clear(): void {
    this.sparks.clear(); this.dust.clear();
    this.m4.makeScale(0, 0, 0); for (let i = 0; i < this.decalN; i++) this.decals.setMatrixAt(i, this.m4);
    this.decalLife.fill(0); this.decalLive = 0; this.decalCursor = 0; this.decals.instanceMatrix.needsUpdate = true; this.decals.visible = false;
  }
  dispose(): void {
    this.sparks.dispose(); this.dust.dispose();
    const m = this.decals.material as THREE.MeshBasicMaterial; m.map?.dispose(); m.dispose(); this.decals.geometry.dispose(); this.decals.removeFromParent();
  }
}
