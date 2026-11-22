// =====================================================================
// 보관함 '요원' 무대 3D 미리보기 — 전용 소형 렌더러 1개를 지연 생성해 재사용 (SkinPreview 와 같은 패턴)
//  - 인게임과 같은 CharacterRig + 리타겟 클립(조준 대기)을 그대로 재생하고 오른손 소켓에 주무기를 쥐어 준다
//  - 드래그 = 좌우 회전 · 더블클릭 = 정면 복귀 · 놓으면 잠시 뒤 천천히 턴테이블
//  - 패널이 화면에 없으면(탭 이동/매치 진입) 루프가 스스로 멈춘다
// =====================================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AGENTS, SIDES, type AgentId } from '../config/agents';
import type { WeaponId } from '../config/weapons';
import { CharacterRig, loadCharacterAssets } from './character';
import { createWeaponMesh } from './network';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const IDLE = { rifle: true, firing: false, reloading: false, crouch: false, air: false, fwd: 0, side: 0, turning: false, pitch: 0 };

export class AgentPreview {
  /** 원하는 자리에 appendChild (innerHTML 재렌더 후 다시 붙여도 상태 유지) */
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(26, 0.75, 0.05, 30);
  private readonly pivot = new THREE.Group();
  private readonly rim = new THREE.DirectionalLight(0xffffff, 2.4);
  private rig: CharacterRig | null = null;
  private shown = ''; private raf = 0; private last = 0; private failed = false; private w = 0; private h = 0;
  private yaw = -0.45; private dragging = false; private idleSince = 0;

  constructor() {
    this.el = document.createElement('div'); this.el.className = 'ag-canvas';
    const key = new THREE.DirectionalLight(0xfff4e6, 2.6); key.position.set(1.6, 2.6, 2.4);
    const fill = new THREE.DirectionalLight(0xc8d6ff, 0.7); fill.position.set(-2.2, 1.4, 1.6);
    this.rim.position.set(-1.2, 2.2, -2.6);
    this.scene.add(this.pivot, new THREE.HemisphereLight(0xdfe8ff, 0x16140f, 0.55), key, fill, this.rim);
    this.camera.position.set(0, 1.05, 5.4); this.camera.lookAt(0, 0.92, 0);
    let px = 0;
    this.el.addEventListener('pointerdown', (e) => { this.dragging = true; px = e.clientX; this.el.setPointerCapture(e.pointerId); });
    this.el.addEventListener('pointermove', (e) => { if (this.dragging) { this.yaw += (e.clientX - px) * 0.012; px = e.clientX; } });
    const up = (): void => { this.dragging = false; this.idleSince = performance.now(); };
    this.el.addEventListener('pointerup', up); this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('dblclick', () => { this.yaw = -0.45; this.idleSince = performance.now(); });
  }

  private ensureRenderer(): boolean {
    if (this.renderer) return true; if (this.failed) return false;
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05; r.setClearColor(0x000000, 0);
      const pm = new THREE.PMREMGenerator(r); this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; this.scene.environmentIntensity = 0.45; pm.dispose();
      this.el.appendChild(r.domElement); this.renderer = r; return true;
    } catch (e) { console.warn('[agentPreview] WebGL 초기화 실패 — 3D 미리보기 비활성:', e); this.failed = true; this.el.classList.add('off'); return false; }
  }

  /** 미리보기 요원 변경 (같은 요원+무기면 무시). 로드 중에는 el 에 .ld 클래스 */
  show(id: AgentId, weapon: WeaponId, skin: string | null): void {
    const key = `${id}|${weapon}|${skin ?? ''}`;
    if (key !== this.shown) {
      this.shown = key; this.el.classList.add('ld');
      this.rim.color.set(SIDES[AGENTS[id].side].color);
      void loadCharacterAssets(id).then((a) => {
        if (this.shown !== key) return;
        this.el.classList.remove('ld');
        this.rig?.dispose(); this.rig = null;
        if (!a) { this.el.classList.add('off'); return; }
        const rig = new CharacterRig(a, 0x000000, 0); rig.setLook(1, false); rig.socket.add(createWeaponMesh(weapon, skin));
        rig.root.rotation.y = Math.PI; // 게임 -Z 전방 → 카메라 쪽(+Z)을 바라보게
        this.pivot.add(rig.root); this.rig = rig;
      });
    }
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.loop); }
  }

  private readonly loop = (now: number): void => {
    this.raf = 0;
    if (!this.el.isConnected || this.el.offsetParent === null || document.hidden) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.ensureRenderer()) return;
    const r = this.renderer!, w = this.el.clientWidth, h = this.el.clientHeight; if (w < 2 || h < 2) return;
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (!this.dragging && now - this.idleSince > 2500 && !REDUCED.matches) this.yaw += dt * 0.35; // 자동 턴테이블 (동작 줄이기 설정 시 정지)
    this.pivot.rotation.y = this.yaw;
    this.rig?.update(dt, IDLE);
    r.render(this.scene, this.camera);
  };
}
