// =====================================================================
// 상점/보관함 카드 썸네일 — 인게임과 똑같은 3D 무기(createWeaponMesh + 스킨 재질 + 등급 파츠)를
// 오프스크린 렌더러 1개로 찍어 이미지로 만든다.
//  - 손으로 그린 SVG/저장된 PNG 가 아니라 "실제 모델을 매번 촬영"하므로, 스킨 정의(config/skins.ts)·
//    텍스처 페인터·FBX/GLB 모델·등급 파츠가 바뀌면 썸네일도 자동으로 바뀐다 (별도 갱신 작업 없음)
//  - 캐시 키에 스킨 정의 전체(JSON)를 포함 → 개발 중 HMR 로 외형만 바꿔도 즉시 재촬영
//  - 요청은 큐로 한 장씩 처리(프레임 분산), 모델 로드가 끝난 뒤 촬영해 박스 폴백이 찍히지 않게 한다
//  - WebGL 이 없으면 null 을 돌려주고 호출측이 기존 실루엣으로 폴백
// =====================================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TIERS, getSkin } from '../config/skins';
import type { WeaponId } from '../config/weapons';
import { createWeaponMesh } from './network';
import { RIGS } from './skinPreview';
import { tickSkinMaterials } from './skinFx';
import { weaponModelReady } from './weaponModels';

const W = 640, H = 320; // 카드 비주얼(2:1)의 레티나 해상도

let renderer: THREE.WebGLRenderer | null = null, failed = false;
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, 0.01, 50);
const pivot = new THREE.Group();
const key = new THREE.DirectionalLight(0xffffff, 2), rimA = new THREE.DirectionalLight(0xffffff, 0), rimB = new THREE.DirectionalLight(0xffffff, 0);
const fill = new THREE.PointLight(0xffffff, 0, 6, 1.6), under = new THREE.PointLight(0xffffff, 0, 4, 1.8);
scene.add(pivot, new THREE.HemisphereLight(0xdfe8ff, 0x1a1c24, 0.5), key, rimA, rimB, fill, under);
key.position.set(0.6, 2.4, 2.6); rimA.position.set(-2.5, 1.2, -2); rimB.position.set(2.5, -0.6, -2.2); fill.position.set(-0.8, 0.6, 1.4); under.position.set(0, -0.6, 0.6);
camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);

function ensure(): boolean {
  if (renderer) return true; if (failed) return false;
  try {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(W, H, false);
    r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.setClearColor(0x000000, 0);
    const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.03).texture; pm.dispose();
    renderer = r; return true;
  } catch (e) { console.warn('[skinThumbs] WebGL 초기화 실패 — 실루엣 폴백:', e); failed = true; return false; }
}

/** 스킨 정의 전체를 서명으로 사용 → 외형 관련 값이 하나라도 바뀌면 캐시 미스 → 재촬영 */
const signature = (weaponId: string, skinId: string | null): string => {
  const def = getSkin(skinId);
  return weaponId + '|' + (def ? def.id + '|' + JSON.stringify(def) : 'std');
};
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
let chain: Promise<unknown> = Promise.resolve();
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/** 이미 촬영된 썸네일 URL (없으면 undefined, 촬영 실패면 null) */
export function cachedSkinThumb(weaponId: string, skinId: string | null): string | null | undefined { return cache.get(signature(weaponId, skinId)); }

/** 썸네일 요청 — 같은 대상은 한 번만 촬영. WebGL 불가 시 null */
export function requestSkinThumb(weaponId: WeaponId, skinId: string | null): Promise<string | null> {
  const sig = signature(weaponId, skinId);
  if (cache.has(sig)) return Promise.resolve(cache.get(sig)!);
  let p = inflight.get(sig);
  if (!p) {
    p = (chain = chain.then(async () => {
      await weaponModelReady(weaponId, skinId).catch(() => undefined);
      await nextFrame(); // 한 프레임에 한 장 — UI 끊김 방지
      const url = await shoot(weaponId, skinId);
      cache.set(sig, url); inflight.delete(sig); return url;
    }).catch((e) => { console.warn('[skinThumbs] 촬영 실패:', weaponId, skinId, e); cache.set(sig, null); inflight.delete(sig); return null; })) as Promise<string | null>;
    inflight.set(sig, p);
  }
  return p;
}

async function shoot(weaponId: WeaponId, skinId: string | null): Promise<string | null> {
  if (!ensure()) return null;
  const r = renderer!, def = getSkin(skinId);
  const model = createWeaponMesh(weaponId, def?.id ?? null); // 모델이 이미 로드돼 있어 실제 FBX/GLB 가 동기로 장착됨
  model.traverse((o) => { o.castShadow = false; });
  // 등급별 조명 — 3D 미리보기와 같은 프로파일
  const rig = RIGS[def?.tier ?? 'none'];
  const col = new THREE.Color(def ? TIERS[def.tier].color : '#8b97ab'), glow = def && def.emissive.mode !== 'none' ? new THREE.Color(def.emissive.color) : col;
  rimA.color.copy(col); rimB.color.copy(glow); under.color.copy(glow); fill.color.copy(col).lerp(new THREE.Color(0xffffff), 0.6);
  key.intensity = rig.key; rimA.intensity = rig.rim; rimB.intensity = rig.rim * 0.7; under.intensity = rig.under; fill.intensity = rig.sweep * 0.7;
  scene.environmentIntensity = rig.env; r.toneMappingExposure = rig.exposure;

  // 측면 3/4 뷰: 총열(-Z)이 화면 오른쪽을 향하도록 -90° + 살짝 비튼 각도
  pivot.add(model); pivot.rotation.set(0.1, -Math.PI / 2 + 0.22, 0); model.position.set(0, 0, 0);
  tickSkinMaterials(performance.now() / 1000);
  scene.updateMatrixWorld(true);
  // 화면에 보이는 메시 기준으로 카메라 공간 경계 계산 → 여백 8% 로 꽉 차게
  const box = new THREE.Box3(), tmp = new THREE.Box3(), view = camera.matrixWorldInverse;
  model.traverseVisible((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld).applyMatrix4(view); box.union(tmp);
  });
  if (box.isEmpty()) { model.removeFromParent(); return null; }
  const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3()), aspect = W / H;
  let hw = size.x / 2, hh = size.y / 2;
  if (hw / hh > aspect) hh = hw / aspect; else hw = hh * aspect;
  hw *= 1.08; hh *= 1.08;
  camera.left = ctr.x - hw; camera.right = ctr.x + hw; camera.top = ctr.y + hh; camera.bottom = ctr.y - hh; camera.updateProjectionMatrix();

  try {
    r.render(scene, camera); // 첫 렌더에서 셰이더 컴파일
    r.render(scene, camera);
  } finally { model.removeFromParent(); } // 실패해도 다음 촬영을 오염시키지 않게 즉시 제거 (지오메트리/재질은 인게임 공유 캐시라 dispose 안 함)
  const blob = await new Promise<Blob | null>((res) => r.domElement.toBlob(res, 'image/webp', 0.92));
  return blob ? URL.createObjectURL(blob) : null;
}
