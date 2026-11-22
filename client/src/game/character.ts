// =====================================================================
// 3인칭 캐릭터: CS2 요원 GLB(진영별 · config/agents.ts) 로드·정규화·인스턴싱 + Mixamo 라이플 애니메이션 리타겟팅.
// - 요원 GLB 는 CS2(Source 2) 리그(pelvis / spine_0~3 / arm_upper_l …)이고 내장 애니메이션이 없다
//   → 공용 Mixamo 클립(models/animations/*.fbx)을 로드 시 1회 CS2 본으로 베이크(월드 회전 델타 리타겟)
// - 정규화: 전방 +Z(Mixamo 와 동일) · 키 1.8m · 발바닥 y=0 · 골반 XZ 원점, A-포즈 바인드는 Mixamo T-포즈 방향으로 정렬
// - 템플릿은 요원별 1회만 로드하고 엔티티마다 SkeletonUtils.clone() (본 공유 방지), 재질은 엔티티별 복제(팀 림라이트·투명도 개별 제어)
// - 클립은 루트 모션(Hips 위치 X/Z)을 제거해 제자리 재생 → 위치는 서버 스냅샷 보간이 담당
// - 비라이플 무기: 클립을 재생하지 않고 정적 '준비 자세' + 절차적 다리 스윙으로 폴백
// =====================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AGENTS, DEFAULT_AGENT, type AgentId } from '../config/agents';
import { FINGERS, handFrame, type ArmTarget } from './karambitViewmodel';

const BASE = import.meta.env?.BASE_URL ?? '/';
const ANIM_DIR = BASE + 'models/animations/';
const HEIGHT = 1.8; // 인게임 캡슐 높이(m)
const FADE = 0.15; // 클립 크로스페이드(s)
const BAKE_FPS = 30; // 리타겟 베이크 샘플링 레이트

const CLIP_FILES = {
  idle: 'Rifle Aiming Idle', fire: 'Firing Rifle', reload: 'Reloading', walk: 'Walk Forward Left',
  strafe: 'Strafing', crouch: 'Walk Crouching Right', jump: 'Jumping Down', turn: 'Rifle Turn',
} as const;
export type ClipKey = keyof typeof CLIP_FILES;

/** 렌더 상태 입력 (RemoteEntity 가 매 프레임 채움) */
export interface CharState {
  rifle: boolean; firing: boolean; reloading: boolean; crouch: boolean; air: boolean;
  /** 캐릭터 로컬 속도(m/s): fwd(+앞) / side(+오른쪽) */ fwd: number; side: number;
  turning: boolean; pitch: number;
}

// ── 본 매핑: Mixamo 논리 이름(접두사 mixamorig 제외) → CS2 본 기본 이름(GLB 노드명 끝 '_숫자' 접미사 제거) ──
const BONE_MAP: Record<string, string> = {
  Hips: 'pelvis', Spine: 'spine_1', Spine1: 'spine_2', Spine2: 'spine_3', Neck: 'neck_0', Head: 'head_0',
};
/** T-포즈 정렬 기준: 본 → 방향을 맞출 자식 관절 */
const ALIGN_CHILD: Record<string, string> = { Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head' };
for (const [S, s] of [['Left', 'l'], ['Right', 'r']] as const) {
  Object.assign(BONE_MAP, {
    [`${S}Shoulder`]: `clavicle_${s}`, [`${S}Arm`]: `arm_upper_${s}`, [`${S}ForeArm`]: `arm_lower_${s}`, [`${S}Hand`]: `hand_${s}`,
    [`${S}UpLeg`]: `leg_upper_${s}`, [`${S}Leg`]: `leg_lower_${s}`, [`${S}Foot`]: `ankle_${s}`, [`${S}ToeBase`]: `ball_${s}`,
  });
  Object.assign(ALIGN_CHILD, {
    [`${S}Shoulder`]: `${S}Arm`, [`${S}Arm`]: `${S}ForeArm`, [`${S}ForeArm`]: `${S}Hand`, [`${S}Hand`]: `${S}HandMiddle1`,
    [`${S}UpLeg`]: `${S}Leg`, [`${S}Leg`]: `${S}Foot`, [`${S}Foot`]: `${S}ToeBase`,
  });
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 3; i++) {
    BONE_MAP[`${S}Hand${f}${i}`] = `finger_${f.toLowerCase()}_${i - 1}_${s}`;
    if (i < 3) ALIGN_CHILD[`${S}Hand${f}${i}`] = `${S}Hand${f}${i + 1}`;
  }
}
const LOGICAL_OF = new Map(Object.entries(BONE_MAP).map(([k, v]) => [v, k]));

interface Pose { q: THREE.Quaternion[]; hips: THREE.Vector3 }
interface Assets {
  template: THREE.Group; clips: Record<ClipKey, THREE.AnimationClip>;
  /** 준비 자세(비라이플) 서기/앉기 — 템플릿 본 순서와 동일한 인덱스 */ neutral: Pose; crouch: Pose;
  /** 무기 소켓의 오른손 로컬 변환 (조준 대기 자세에서 총구가 왼손 방향을 향하도록 보정) */ gripPos: THREE.Vector3; gripQuat: THREE.Quaternion; socketScale: number;
  /** 부모 공간 기준 회전축: 허리 숙임(피치) · 다리 스윙 */ spineAxes: THREE.Vector3[]; legAxes: THREE.Vector3[];
}

const boneList = (root: THREE.Object3D): THREE.Bone[] => { const out: THREE.Bone[] = []; root.traverse((o) => { if ((o as THREE.Bone).isBone) out.push(o as THREE.Bone); }); return out; };
/** Mixamo 논리 이름 → 이 리그의 본 인덱스 */
const findBone = (bones: THREE.Bone[], logical: string): number => bones.findIndex((b) => b.name === BONE_MAP[logical]);
const SPINE = ['Spine', 'Spine1', 'Spine2'], LEGS = ['LeftUpLeg', 'RightUpLeg'], LEFT_ARM = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'];
const LOWER = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];

const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();
const wPos = (o: THREE.Object3D): THREE.Vector3 => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
const wQuat = (o: THREE.Object3D): THREE.Quaternion => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(_p, q, _s); return q; };

/** 루트 모션 제거: Hips 위치의 X/Z 를 첫 프레임 값으로 고정. 점프 클립은 높은 곳에서 시작하므로 Y 를 서있는 높이로 클램프 */
function inPlace(clip: THREE.AnimationClip, maxY = Infinity): THREE.AnimationClip {
  for (const t of clip.tracks) {
    if (!/Hips\.position$/.test(t.name)) continue;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 1] = Math.min(v[i + 1], maxY); v[i + 2] = z0; }
  }
  return clip;
}

/** 모델 공간 축 → 해당 본의 부모 공간 축 (템플릿은 단위 변환 상태에서 계산) */
function parentAxis(b: THREE.Bone, modelAxis: THREE.Vector3): THREE.Vector3 {
  const q = new THREE.Quaternion(); b.parent!.getWorldQuaternion(q); return modelAxis.clone().applyQuaternion(q.invert()).normalize();
}

// ── 공용 Mixamo 애니메이션 소스 (스켈레톤 + 클립, 모든 요원이 공유) ──
interface AnimSource { skel: THREE.Group; bone: (logical: string) => THREE.Bone; clips: Record<ClipKey, THREE.AnimationClip> }
let animP: Promise<AnimSource> | null = null;
function loadAnimSource(): Promise<AnimSource> {
  return (animP ??= (async () => {
    const loader = new FBXLoader(), keys = Object.keys(CLIP_FILES) as ClipKey[];
    const files = await Promise.all(keys.map((k) => loader.loadAsync(ANIM_DIR + encodeURIComponent(CLIP_FILES[k]) + '.fbx')));
    const hipStand = 95; // 조준 대기 자세 Hips 높이(cm) 근방
    const clips = Object.fromEntries(keys.map((k, i) => [k, inPlace(files[i].animations[0], k === 'jump' ? hipStand : Infinity)])) as Record<ClipKey, THREE.AnimationClip>;
    const skel = files[0]; skel.updateMatrixWorld(true); // 파일 기본 자세 = Mixamo T-포즈 (리타겟 기준)
    const bones = boneList(skel);
    const bone = (logical: string): THREE.Bone => { const b = bones.find((x) => x.name === 'mixamorig' + logical); if (!b) throw new Error('Mixamo 본 없음: ' + logical); return b; };
    return { skel, bone, clips };
  })());
}

/**
 * 리타겟 베이크: 소스 본의 '레스트 대비 월드 회전 델타'를 타겟 본의 (T-포즈 정렬된) 레스트 월드 회전에 적용.
 *   타겟 월드 = 소스 월드(t) · 소스 레스트 월드⁻¹ · 타겟 레스트 월드 → 부모 월드⁻¹ 로 로컬화.
 * 골반 높이는 레스트 골반 높이 비율로 스케일(앉기/점프 높이 보존), XZ 는 제자리.
 */
function bakeClip(clip: THREE.AnimationClip, src: AnimSource, root: THREE.Object3D, bones: THREE.Bone[]): THREE.AnimationClip {
  const mapped = bones.map((b) => { const l = LOGICAL_OF.get(b.name); return l ? { s: src.bone(l), restS: wQuat(src.bone(l)).invert(), restT: wQuat(b) } : null; });
  const hipsT = bones.find((b) => b.name === BONE_MAP.Hips)!, hipsS = src.bone('Hips');
  const restTP = wPos(hipsT), restSY = wPos(hipsS).y, ratio = restTP.y / Math.max(1e-3, restSY);
  const saved = bones.map((b) => [b.quaternion.clone(), b.position.clone()] as const);
  const mixer = new THREE.AnimationMixer(src.skel), act = mixer.clipAction(clip); act.play();
  const n = Math.max(2, Math.round(clip.duration * BAKE_FPS) + 1), times = new Float32Array(n);
  const qv = mapped.map((m) => (m ? new Float32Array(n * 4) : null)), pv = new Float32Array(n * 3);
  const q = new THREE.Quaternion(), pq = new THREE.Quaternion();
  for (let f = 0; f < n; f++) {
    const t = Math.min(f / BAKE_FPS, clip.duration - 1e-4); times[f] = f / BAKE_FPS;
    mixer.setTime(Math.max(0, t)); src.skel.updateMatrixWorld(true);
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i], m = mapped[i];
      if (m) {
        q.copy(wQuat(m.s)).multiply(m.restS).multiply(m.restT); // 목표 월드 회전
        b.parent!.matrixWorld.decompose(_p, pq, _s); b.quaternion.copy(pq.invert().multiply(q));
        q.copy(b.quaternion).toArray(qv[i]!, f * 4);
        if (b === hipsT) {
          _p.set(restTP.x, restTP.y + (wPos(hipsS).y - restSY) * ratio, restTP.z).applyMatrix4(_m.copy(b.parent!.matrixWorld).invert());
          b.position.copy(_p); _p.toArray(pv, f * 3);
        }
      }
      b.updateWorldMatrix(false, false);
    }
  }
  mixer.stopAllAction(); mixer.uncacheRoot(src.skel); src.skel.updateMatrixWorld(true); // 소스도 레스트(T-포즈)로 복원
  bones.forEach((b, i) => { b.quaternion.copy(saved[i][0]); b.position.copy(saved[i][1]); });
  root.updateMatrixWorld(true);
  const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack(`${hipsT.name}.position`, times, pv)];
  bones.forEach((b, i) => { if (qv[i]) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, qv[i]!)); });
  return new THREE.AnimationClip(clip.name, times[n - 1], tracks);
}

async function buildAgent(id: AgentId): Promise<Assets> {
  const [gltf, src] = await Promise.all([new GLTFLoader().loadAsync(BASE + AGENTS[id].model), loadAnimSource()]);
  const inner = gltf.scene, template = new THREE.Group(); template.add(inner);
  const bones = boneList(inner);
  for (const b of bones) b.name = b.name.replace(/_\d+$/, ''); // 요원마다 다른 접미사(arm_upper_l_015 / _014) 제거 → 공통 본 이름
  inner.traverse((o) => {
    const m = o as THREE.SkinnedMesh; if (!m.isMesh) return;
    m.castShadow = true; m.frustumCulled = false; // 스킨 애니메이션 시 바인드 포즈 바운딩으로 잘못 컬링되는 것 방지
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.userData.baseTransparent = mat.transparent;
  });
  const B = (logical: string): THREE.Bone => { const i = findBone(bones, logical); if (i < 0) throw new Error(`[${id}] CS2 본 없음: ${BONE_MAP[logical]}`); return bones[i]; };

  // ── 정규화 1: 전방을 +Z 로 (양손 위치로 오른쪽 벡터 → 전방 = 위 × 오른쪽) ──
  template.updateMatrixWorld(true);
  const right = wPos(B('RightHand')).sub(wPos(B('LeftHand'))).setY(0).normalize(), fwd = new THREE.Vector3(0, 1, 0).cross(right);
  inner.rotation.y += Math.atan2(-fwd.x, fwd.z);
  // ── 정규화 2: 바인드 포즈 기준 키 1.8m · 발바닥 y=0 · 골반 XZ 원점 ──
  template.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(template), s = HEIGHT / (box.max.y - box.min.y);
  inner.scale.multiplyScalar(s); inner.position.multiplyScalar(s); inner.position.y -= box.min.y * s;
  template.updateMatrixWorld(true);
  const pelvis = wPos(B('Hips')); inner.position.x -= pelvis.x; inner.position.z -= pelvis.z;
  template.updateMatrixWorld(true);

  // ── T-포즈 정렬: 각 매핑 본의 '본→자식' 방향을 Mixamo 레스트(T-포즈) 방향과 일치 (부모부터 순서대로) ──
  for (const b of bones) {
    const l = LOGICAL_OF.get(b.name), cl = l && ALIGN_CHILD[l]; if (!cl) continue;
    const td = wPos(B(cl)).sub(wPos(b)).normalize(), sd = wPos(src.bone(cl)).sub(wPos(src.bone(l))).normalize();
    const wq = new THREE.Quaternion().setFromUnitVectors(td, sd).multiply(wQuat(b));
    b.quaternion.copy(wQuat(b.parent!).invert().multiply(wq)); template.updateMatrixWorld(true);
  }
  const clips = Object.fromEntries((Object.keys(CLIP_FILES) as ClipKey[]).map((k) => [k, bakeClip(src.clips[k], src, template, bones)])) as Record<ClipKey, THREE.AnimationClip>;

  // ── 보정값 계산: 템플릿 복제본에 조준 대기 첫 프레임 적용 ──
  const probe = cloneSkinned(template) as THREE.Group;
  const pb = boneList(probe), hips = findBone(pb, 'Hips'), mixer = new THREE.AnimationMixer(probe);
  const sample = (clip: THREE.AnimationClip): Pose => {
    mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); mixer.update(0); probe.updateMatrixWorld(true);
    return { q: pb.map((b) => b.quaternion.clone()), hips: pb[hips].position.clone() };
  };
  const crouchPose = sample(clips.crouch), neutral = sample(clips.idle);
  const rh = pb[findBone(pb, 'RightHand')], lh = pb[findBone(pb, 'LeftHand')], mid = pb[findBone(pb, 'RightHandMiddle1')];
  const rp = rh.getWorldPosition(new THREE.Vector3()), lp = lh.getWorldPosition(new THREE.Vector3()), rq = rh.getWorldQuaternion(new THREE.Quaternion());
  // 무기 로컬 -Z(총구)가 오른손→왼손(총열 지지) 방향, +Y 가 위를 향하는 회전
  const zAxis = rp.clone().sub(lp).normalize(), xAxis = new THREE.Vector3(0, 1, 0).cross(zAxis).normalize(), yAxis = zAxis.clone().cross(xAxis);
  const wq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  const gripQuat = rq.clone().invert().multiply(wq);
  const gripPos = rh.worldToLocal(mid.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.55); // 손목→손바닥 중앙
  const socketScale = 1 / rh.getWorldScale(new THREE.Vector3()).x; // 소켓 하위 무기는 미터 단위
  const spineAxes = SPINE.map((n) => parentAxis(pb[findBone(pb, n)], new THREE.Vector3(1, 0, 0)));
  const legAxes = LEGS.map((n) => parentAxis(pb[findBone(pb, n)], new THREE.Vector3(1, 0, 0)));
  // 준비 자세 = 조준 대기 첫 프레임에서 왼팔만 T-포즈로 되돌린 뒤 몸 옆으로 내림 (오른손은 무기를 앞으로 든 상태 유지)
  mixer.stopAllAction(); mixer.uncacheRoot(probe); // → 정렬된 T-포즈로 복원됨
  neutral.q.forEach((q, i) => { if (!LEFT_ARM.some((n) => findBone(pb, n) === i)) pb[i].quaternion.copy(q); });
  probe.updateMatrixWorld(true);
  for (const n of LEFT_ARM) neutral.q[findBone(pb, n)].copy(pb[findBone(pb, n)].quaternion);
  const la = findBone(pb, 'LeftArm');
  neutral.q[la].premultiply(new THREE.Quaternion().setFromAxisAngle(parentAxis(pb[la], new THREE.Vector3(0, 0, 1)), -1.25));
  // 앉은 준비 자세 = 준비 자세 상체 + 앉아 이동 클립 첫 프레임의 하체
  const crouch: Pose = { q: neutral.q.map((q) => q.clone()), hips: crouchPose.hips };
  for (const n of LOWER) { const i = findBone(pb, n); crouch.q[i].copy(crouchPose.q[i]); }
  return { template, clips, neutral, crouch, gripPos, gripQuat, socketScale, spineAxes, legAxes };
}

const assetsP = new Map<AgentId, Promise<Assets | null>>();
/** 요원별 에셋(템플릿 + 리타겟 클립) — 요원당 1회만 로드. 실패 시 null(호출부는 절차적 캐릭터로 폴백) */
export function loadCharacterAssets(id: AgentId = DEFAULT_AGENT.ct): Promise<Assets | null> {
  let p = assetsP.get(id);
  if (!p) { p = buildAgent(id).catch((e) => { console.warn(`[character] 요원 ${id} 로드 실패 — 기본 캐릭터로 폴백`, e); return null; }); assetsP.set(id, p); }
  return p;
}

// 팀 림라이트: 시선과 수직인 외곽선에 팀 색을 더한다 (모든 인스턴스가 같은 셰이더 프로그램 공유)
function addRim(m: THREE.MeshStandardMaterial, color: THREE.Color, strength: { value: number }): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = { value: color }; sh.uniforms.uRimStr = strength;
    sh.fragmentShader = 'uniform vec3 uRimColor;\nuniform float uRimStr;\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
      'float rimF = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.4);\noutgoingLight += uRimColor * rimF * uRimStr;\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'duelist-rim';
}

const _q = new THREE.Quaternion(), _hp = new THREE.Vector3(), _pq = new THREE.Quaternion(), _aq = new THREE.Quaternion();
/** 본의 월드 회전을 q 로 맞추고(부모 월드 기준 로컬화) 하위 행렬까지 갱신 */
function setWorldQuat(b: THREE.Object3D, q: THREE.Quaternion): void {
  b.parent!.matrixWorld.decompose(_p, _pq, _s); b.quaternion.copy(_pq.invert().multiply(q)); b.updateMatrixWorld(true);
}
/** 본을 월드 방향 from → to 로 최소 회전 */
function aimBone(b: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3): void {
  if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) return;
  setWorldQuat(b, _aq.setFromUnitVectors(from.normalize(), to.clone().normalize()).multiply(wQuat(b)));
}
/** 엔티티 1개분 요원 인스턴스 */
export class CharacterRig {
  readonly root = new THREE.Group(); // 엔티티 그룹에 붙는 래퍼 (-Z 전방 · 미터 단위)
  /** 3인칭 무기를 붙이는 소켓 (오른손 본 하위, 미터 스케일) */ readonly socket = new THREE.Group();
  /** 손목 기준 좌표 = CS2 weapon_hand_r / weapon_hand_l 본 (v_knife 등 CS2 무기 애니메이션 부착점) */ readonly wrists: { r: THREE.Bone | null; l: THREE.Bone | null };
  private readonly model: THREE.Group;
  private readonly bones: THREE.Bone[];
  private readonly hips: number;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Record<ClipKey, THREE.AnimationAction>;
  private readonly mats: THREE.MeshStandardMaterial[] = [];
  private readonly rimColor = new THREE.Color(); private readonly rimStr = { value: 0.9 };
  private readonly spine: number[]; private readonly legs: number[];
  private readonly headBones: THREE.Bone[]; private fp = false;
  private cur: ClipKey | null = null;
  private rifle: boolean | null = null;
  private wasCrouch = false; private phase = 0;
  /** 모드 전환(라이플 ↔ 준비 자세) 시 이전 포즈에서 부드럽게 넘어가기 위한 스냅샷 */
  private snap: THREE.Quaternion[] | null = null; private snapHips = new THREE.Vector3(); private snapT = 0;

  constructor(private readonly a: Assets, color: number, entityId: number) {
    this.model = cloneSkinned(a.template) as THREE.Group;
    this.model.rotation.y = Math.PI; // 템플릿 +Z 전방 → 게임 -Z 전방
    this.root.add(this.model);
    this.bones = boneList(this.model); this.hips = findBone(this.bones, 'Hips');
    this.model.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      m.userData.entityId = entityId;
      const clone = (x: THREE.Material): THREE.MeshStandardMaterial => { const c = (x as THREE.MeshStandardMaterial).clone(); addRim(c, this.rimColor, this.rimStr); this.mats.push(c); return c; };
      m.material = Array.isArray(m.material) ? m.material.map(clone) : clone(m.material);
    });
    this.setColor(color);
    const hand = this.bones[findBone(this.bones, 'RightHand')];
    this.socket.position.copy(a.gripPos); this.socket.quaternion.copy(a.gripQuat); this.socket.scale.setScalar(a.socketScale); hand.add(this.socket);
    const byName = (n: string): THREE.Bone | null => this.bones.find((b) => b.name === n) ?? null;
    this.wrists = { r: byName('weapon_hand_r'), l: byName('weapon_hand_l') };
    this.spine = SPINE.map((n) => findBone(this.bones, n)); this.legs = LEGS.map((n) => findBone(this.bones, n));
    this.headBones = this.bones.filter((b) => b.name === 'neck_0' || b.name === 'head_0');
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = Object.fromEntries((Object.keys(a.clips) as ClipKey[]).map((k) => {
      const act = this.mixer.clipAction(a.clips[k]);
      if (k === 'jump') { act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; }
      return [k, act];
    })) as Record<ClipKey, THREE.AnimationAction>;
  }

  /** 1인칭(본인 시점): 머리·목 본을 0 스케일로 숨겨 카메라가 방독면/발라클라바 메쉬에 가려지지 않게 한다 (매 프레임 애니메이션 뒤에 재적용) */
  setFirstPerson(on: boolean): void { this.fp = on; if (!on) this.headBones.forEach((b) => b.scale.setScalar(1)); }

  setColor(hex: number): void { this.rimColor.setHex(hex); }
  /** 은신/보호/시전 투명도 + 대시·회복 시 림 강조 (원래 반투명 재질(렌즈 등)은 유지) */
  setLook(opacity: number, glow: boolean): void {
    for (const m of this.mats) {
      const tr = opacity < 1 || !!m.userData.baseTransparent;
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      if (!m.userData.baseTransparent) { m.opacity = opacity; m.depthWrite = !tr; }
    }
    this.rimStr.value = glow ? 2.2 : 0.9;
  }

  private takeSnapshot(): void {
    this.snap = this.bones.map((b) => b.quaternion.clone()); this.snapHips.copy(this.bones[this.hips].position); this.snapT = 0;
  }
  private play(k: ClipKey, timeScale: number): void {
    const act = this.actions[k]; act.timeScale = timeScale;
    if (this.cur === k) return;
    if (k === 'jump') act.reset();
    act.enabled = true; act.setEffectiveWeight(1);
    // 첫 클립은 페이드 없이(가중치<1이면 T-포즈가 섞임) — 이전 포즈와의 블렌드는 스냅샷이 담당
    if (this.cur) act.crossFadeFrom(this.actions[this.cur], FADE, false);
    act.play(); this.cur = k;
  }
  private pickClip(s: CharState): [ClipKey, number] {
    const speed = Math.hypot(s.fwd, s.side), moving = speed > 0.6, walkRate = Math.min(2.2, Math.max(0.8, speed / 1.8));
    if (s.reloading) return ['reload', 1];
    if (s.firing) return ['fire', 1];
    if (s.air) return ['jump', 1.6];
    if (s.crouch) return ['crouch', moving ? (s.side < -0.3 ? -1 : 1) * Math.min(1.6, Math.max(0.7, speed / 2)) : 0]; // 앉아 정지 = 현재 프레임에서 정지
    if (moving && Math.abs(s.side) > Math.abs(s.fwd)) return ['strafe', (s.side > 0 ? -1 : 1) * walkRate]; // 클립은 왼쪽 이동 → 오른쪽은 역재생
    if (moving) return ['walk', (s.fwd >= 0 ? 1 : -1) * walkRate];
    if (s.turning) return ['turn', 1];
    return ['idle', 1];
  }

  update(dt: number, s: CharState): void {
    if (s.rifle !== this.rifle) {
      if (this.rifle !== null) this.takeSnapshot();
      this.rifle = s.rifle;
      if (!s.rifle) { this.mixer.stopAllAction(); this.cur = null; }
    }
    const b = this.bones, hips = b[this.hips];
    if (s.rifle) {
      this.play(...this.pickClip(s)); this.mixer.update(dt);
    } else {
      // 준비 자세(서기/앉기) + 이동 시 절차적 다리 스윙 (라이플 클립은 재생하지 않음)
      const pose = s.crouch ? this.a.crouch : this.a.neutral;
      if (s.crouch !== this.wasCrouch && this.snap === null) this.takeSnapshot();
      for (let i = 0; i < b.length; i++) b[i].quaternion.copy(pose.q[i]);
      hips.position.copy(pose.hips);
      const speed = Math.hypot(s.fwd, s.side);
      this.phase += dt * Math.min(12, speed * 1.6);
      const amp = Math.min(0.5, speed * 0.1) * (s.air ? 0.3 : s.crouch ? 0.5 : 1) * (s.fwd < -0.3 ? -1 : 1);
      this.legs.forEach((li, j) => b[li].quaternion.premultiply(_q.setFromAxisAngle(this.a.legAxes[j], Math.sin(this.phase + j * Math.PI) * amp)));
    }
    this.wasCrouch = s.crouch;
    // 시선 피치: 허리 3개 본에 나눠서 숙임/젖힘 (모델 공간 X 축 기준)
    const p = -s.pitch / 3;
    this.spine.forEach((si, j) => b[si].quaternion.premultiply(_q.setFromAxisAngle(this.a.spineAxes[j], p)));
    // 모드 전환 블렌드 (T-포즈를 거치지 않도록 스냅샷에서 목표 포즈로 보간)
    if (this.snap) {
      this.snapT += dt; const t = Math.min(1, this.snapT / FADE);
      for (let i = 0; i < b.length; i++) b[i].quaternion.slerpQuaternions(this.snap[i], _q.copy(b[i].quaternion), t);
      hips.position.lerpVectors(this.snapHips, _hp.copy(hips.position), t);
      if (t >= 1) this.snap = null;
    }
    if (this.fp) for (const hb of this.headBones) hb.scale.setScalar(0);
  }

  /**
   * 1인칭 카람빗: update() 직후 오른팔을 뷰모델 목표로 정렬한다.
   * 어깨→팔꿈치→손목 2본 IK(팔꿈치 힌트 방향으로 굽힘) → 손 회전(MDL 손 프레임을 이 리그의 손 프레임으로 환산) → 손가락 마디 방향 일치.
   * 반환값 = 실제 손목 월드 위치(팔 길이 밖 목표는 최대 신장에서 멈춤)
   */
  poseRightArm(t: ArmTarget): THREE.Vector3 {
    const arm = this.arm ??= this.buildArm();
    this.root.updateMatrixWorld(true);
    const S = wPos(arm.upper), E0 = wPos(arm.lower), H0 = wPos(arm.hand);
    const a = E0.distanceTo(S), b = H0.distanceTo(E0), toT = t.hand.clone().sub(S), d = Math.min(Math.max(toT.length(), 1e-4), (a + b) * 0.999);
    const n = toT.normalize(), pole = t.elbow.clone().sub(S); pole.addScaledVector(n, -pole.dot(n));
    if (pole.lengthSq() < 1e-8) pole.set(0, -1, 0).addScaledVector(n, -n.y); pole.normalize();
    const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d))), E = S.clone().addScaledVector(n, a * cosA).addScaledVector(pole, a * Math.sqrt(1 - cosA * cosA));
    aimBone(arm.upper, E0.sub(S), E.clone().sub(S));
    const El = wPos(arm.lower); aimBone(arm.lower, wPos(arm.hand).sub(El), S.addScaledVector(n, d).sub(El));
    // 손: 목표 월드 회전 = MDL 손 회전 · MDL 손 프레임 · (이 리그 손 프레임)⁻¹
    setWorldQuat(arm.hand, new THREE.Quaternion().copy(t.handQuat).multiply(t.handFrame).multiply(arm.frameInv));
    // 손가락: 각 마디의 '뼈 방향'을 MDL 마디 방향(월드)에 맞춘다 (부모 → 자식 순, setWorldQuat 가 하위 행렬까지 갱신)
    arm.fingers.forEach((f, i) => { if (f) aimBone(f.bone, f.dir.clone().applyQuaternion(wQuat(f.bone)), t.fingers[i]); });
    return wPos(arm.hand);
  }
  /** 오른손 손목 → 중지 뿌리 월드 거리(m) — 손 크기가 다른 MDL 손의 칼 오프셋을 이 장갑 크기에 맞춰 축척할 때 사용 */
  rightHandSpan(): number { const arm = this.arm ??= this.buildArm(); return wPos(arm.hand).distanceTo(wPos(arm.middle)); }
  private arm: { upper: THREE.Bone; lower: THREE.Bone; hand: THREE.Bone; middle: THREE.Bone; frameInv: THREE.Quaternion; fingers: ({ bone: THREE.Bone; dir: THREE.Vector3 } | null)[] } | null = null;
  private buildArm(): NonNullable<CharacterRig['arm']> {
    const B = (l: string): THREE.Bone => this.bones[findBone(this.bones, l)];
    const hand = B('RightHand'); this.model.updateMatrixWorld(true);
    const local = (o: THREE.Object3D): THREE.Vector3 => hand.worldToLocal(wPos(o));
    const fb = (f: string, j: number): THREE.Bone | undefined => this.bones.find((x) => x.name === `finger_${f}_${j}_r`);
    const frame = handFrame(local(fb('middle', 0)!), local(fb('index', 0)!).sub(local(fb('pinky', 0)!)));
    // 마디 뼈 방향(본 로컬): 다음 마디가 있으면 그쪽, 끝 마디는 직전 마디 방향 연장
    const fingers = FINGERS.flatMap((f) => [0, 1, 2].map((j) => {
      const bone = fb(f, j); if (!bone) return null;
      const next = fb(f, j + 1), dir = next ? bone.worldToLocal(wPos(next)) : bone.position.clone().applyQuaternion(bone.quaternion.clone().invert());
      return { bone, dir: dir.normalize() };
    }));
    return { upper: B('RightArm'), lower: B('RightForeArm'), hand, middle: fb('middle', 0)!, frameInv: frame.invert(), fingers };
  }

  dispose(): void {
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
    for (const m of this.mats) m.dispose();
    this.root.removeFromParent();
  }
}
