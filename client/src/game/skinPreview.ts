// =====================================================================
// 상점/보관함 3D 스킨 미리보기 — 전용 소형 렌더러 1개를 지연 생성해 재사용.
//  - 인게임과 같은 createWeaponMesh / 캐시된 스킨 재질을 그대로 쓴다(미리보기 = 실제 외형)
//  - 조명 리그는 고정(조명 개수 불변 → 셰이더 재컴파일 없음), 등급이 오를수록
//    IBL 강도 · 노출 · 등급색 림 라이트 · 스윕 하이라이트가 강해져 광택 차이가 드러난다
//  - 패널이 화면에 없으면(탭 이동/매치 진입) 루프가 스스로 멈춘다
// =====================================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TIERS, getSkin, type Tier } from '../config/skins';
import type { WeaponId } from '../config/weapons';
import { createWeaponMesh } from './network';
import { tickSkinMaterials } from './skinFx';

export interface Rig { env: number; exposure: number; key: number; rim: number; sweep: number; under: number }
/** 등급별 조명 프로파일 — 기본 외형(null)은 가장 수수하게 */
export const RIGS: Record<Tier | 'none', Rig> = {
  none: { env: 0.45, exposure: 0.95, key: 1.9, rim: 0, sweep: 0, under: 0 },
  default: { env: 0.5, exposure: 0.97, key: 2.0, rim: 0.2, sweep: 0.2, under: 0.05 },
  consumer: { env: 0.6, exposure: 1.0, key: 2.2, rim: 0.5, sweep: 0.5, under: 0.15 },
  industrial: { env: 0.72, exposure: 1.02, key: 2.3, rim: 0.9, sweep: 0.9, under: 0.25 },
  milspec: { env: 0.85, exposure: 1.05, key: 2.4, rim: 1.4, sweep: 1.4, under: 0.35 },
  restricted: { env: 0.98, exposure: 1.08, key: 2.5, rim: 2.0, sweep: 2.0, under: 0.52 },
  classified: { env: 1.1, exposure: 1.1, key: 2.6, rim: 2.6, sweep: 2.6, under: 0.7 },
  covert: { env: 1.4, exposure: 1.19, key: 2.75, rim: 4.5, sweep: 4.2, under: 1.35 },
  exrare: { env: 1.5, exposure: 1.22, key: 2.8, rim: 5.2, sweep: 4.8, under: 1.6 },
  contraband: { env: 1.5, exposure: 1.22, key: 2.8, rim: 5.2, sweep: 4.8, under: 1.6 },
};

export class SkinPreview {
  /** 이 요소를 원하는 자리에 appendChild 하면 된다 (innerHTML 재렌더 후 다시 붙여도 상태 유지) */
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 2, 0.01, 20);
  private readonly pivot = new THREE.Group();
  private readonly key = new THREE.DirectionalLight(0xffffff, 2);
  private readonly rimA = new THREE.DirectionalLight(0xffffff, 0);
  private readonly rimB = new THREE.DirectionalLight(0xffffff, 0);
  private readonly sweep = new THREE.PointLight(0xffffff, 0, 6, 1.6);
  private readonly under = new THREE.PointLight(0xffffff, 0, 4, 1.8);
  private model: THREE.Group | null = null;
  private shown = ''; private rig: Rig = RIGS.none; private raf = 0; private frames = 0; private failed = false;
  private yaw = 0.5; private pitch = 0.12; private zoom = 1; private fitDist = 1; private pitchLim = 0.7; private dragging = false; private idleSince = 0; private w = 0; private h = 0;

  constructor() {
    this.el = document.createElement('div'); this.el.className = 'pv-stage';
    this.scene.add(this.pivot, new THREE.HemisphereLight(0xdfe8ff, 0x1a1c24, 0.5), this.key, this.rimA, this.rimB, this.sweep, this.under);
    this.key.position.set(1.2, 2.2, 2.4); this.rimA.position.set(-2.5, 1.2, -2); this.rimB.position.set(2.5, -0.6, -2.2); this.under.position.set(0, -0.6, 0.5);
    let px = 0, py = 0;
    this.el.addEventListener('pointerdown', (e) => { this.dragging = true; px = e.clientX; py = e.clientY; this.el.setPointerCapture(e.pointerId); });
    this.el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw += (e.clientX - px) * 0.011; this.pitch = Math.max(-this.pitchLim, Math.min(this.pitchLim, this.pitch + (e.clientY - py) * 0.008)); px = e.clientX; py = e.clientY;
    });
    this.el.addEventListener('dblclick', () => this.resetView());
    this.el.addEventListener('wheel', (e) => { if (!this.zoomable) return; e.preventDefault(); this.zoom = Math.max(0.35, Math.min(2.5, this.zoom * Math.exp(e.deltaY * 0.001))); this.applyZoom(); }, { passive: false });
    const up = (): void => { this.dragging = false; this.idleSince = performance.now(); };
    this.el.addEventListener('pointerup', up); this.el.addEventListener('pointercancel', up);
  }

  /** 조사 뷰어용: 휠 줌 허용 + 상하 회전 범위 확장(true). 기본(로비 무대)은 줌 없음 */
  zoomable = false;
  setInspect(on: boolean): void { this.zoomable = on; this.pitchLim = on ? 1.45 : 0.7; }
  /** 정면 기본 각도 + 기본 줌으로 복귀 */
  resetView(): void { this.yaw = 0.5; this.pitch = 0.12; this.zoom = 1; this.idleSince = performance.now(); this.applyZoom(); }
  private applyZoom(): void { this.camera.position.z = this.fitDist * this.zoom; }

  private ensureRenderer(): boolean {
    if (this.renderer) return true; if (this.failed) return false;
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.setClearColor(0x000000, 0);
      const pm = new THREE.PMREMGenerator(r); this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture; pm.dispose();
      this.el.appendChild(r.domElement); this.renderer = r; return true;
    } catch (e) { console.warn('[skinPreview] WebGL 초기화 실패 — 3D 미리보기 비활성:', e); this.failed = true; this.el.classList.add('off'); return false; }
  }

  /** 미리보기 대상 변경 (같은 대상이면 무시). skinId 가 없거나 알 수 없으면 기본 외형 */
  show(weaponId: WeaponId, skinId: string | null | undefined): void {
    const def = getSkin(skinId), id = weaponId + '|' + (def?.id ?? '');
    if (id !== this.shown) {
      this.shown = id; this.model?.removeFromParent();
      this.model = createWeaponMesh(weaponId, def?.id ?? null); this.model.traverse((o) => { o.castShadow = false; });
      this.pivot.add(this.model); this.frames = 0; if (this.zoomable) this.resetView();
      this.rig = RIGS[def?.tier ?? 'none'];
      const col = new THREE.Color(def ? TIERS[def.tier].color : '#8b97ab'), glow = def && def.emissive.mode !== 'none' ? new THREE.Color(def.emissive.color) : col;
      this.rimA.color.copy(col); this.rimB.color.copy(glow); this.under.color.copy(glow); this.sweep.color.copy(col).lerp(new THREE.Color(0xffffff), 0.6);
      this.key.intensity = this.rig.key; this.rimA.intensity = this.rig.rim; this.rimB.intensity = this.rig.rim * 0.7; this.under.intensity = this.rig.under;
      this.scene.environmentIntensity = this.rig.env;
    }
    this.start();
  }

  private start(): void { if (!this.raf) this.raf = requestAnimationFrame(this.loop); }

  /** 모델(등급 파츠 제외) 경계에 맞춰 중앙 정렬 + 카메라 거리 결정. FBX 가 비동기로 교체되므로 초반 몇 프레임 반복 */
  private fit(): void {
    const m = this.model; if (!m) return;
    const rot = this.pivot.rotation.clone(); this.pivot.rotation.set(0, 0, 0); // 회전을 잠시 풀고 모델 로컬 기준으로 측정
    m.position.set(0, 0, 0); this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3(), tmp = new THREE.Box3();
    for (const c of m.children) { if (c.userData.keep || c === m.userData.muzzle) continue; tmp.setFromObject(c); if (!tmp.isEmpty()) box.union(tmp); }
    this.pivot.rotation.copy(rot);
    if (box.isEmpty()) { this.pivot.updateMatrixWorld(true); return; }
    const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
    m.position.copy(ctr).multiplyScalar(-1); this.pivot.updateMatrixWorld(true);
    const len = Math.max(size.z, size.x), halfV = Math.tan((this.camera.fov * Math.PI) / 360), aspect = this.camera.aspect;
    this.fitDist = Math.max((len * 0.57) / (halfV * aspect), (size.y * 0.8) / halfV, 0.3) + 0.04;
    this.camera.position.set(0, 0, this.fitDist * this.zoom);
    this.camera.lookAt(0, 0, 0);
  }

  private readonly loop = (now: number): void => {
    this.raf = 0;
    if (!this.el.isConnected || this.el.offsetParent === null || document.hidden) return; // 화면에서 사라지면 정지 (다음 show() 때 재개)
    this.raf = requestAnimationFrame(this.loop);
    if (!this.ensureRenderer()) return;
    const r = this.renderer!, w = this.el.clientWidth, h = this.el.clientHeight; if (w < 2 || h < 2) return;
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.frames = 0; }
    const t = now / 1000;
    if (!this.dragging && now - this.idleSince > 1200) this.yaw += 0.006; // 자동 턴테이블
    this.pivot.rotation.set(this.pitch, this.yaw + Math.PI / 2, 0);    // 총열(-Z)이 화면 가로로 오도록 +90°
    this.pivot.updateMatrixWorld(true);
    if (this.frames < 180 && this.frames % 6 === 0) this.fit();
    this.frames++;
    this.sweep.position.set(Math.sin(t * 0.9) * 1.6, 0.5 + 0.3 * Math.sin(t * 0.6), 1.1); this.sweep.intensity = this.rig.sweep * (0.6 + 0.4 * Math.sin(t * 0.9 + 1)); // 표면을 훑는 하이라이트
    r.toneMappingExposure = this.rig.exposure;
    tickSkinMaterials(t);
    r.render(this.scene, this.camera);
  };
}
