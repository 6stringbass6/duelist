// =====================================================================
// 3인칭 캐릭터: Swat.fbx (Mixamo 리그) 로드·정규화·인스턴싱 + 라이플(AK-47/팬텀) 전용 Mixamo 애니메이션.
// - 템플릿은 1회만 로드하고 엔티티마다 SkeletonUtils.clone() (본 공유 방지), 재질은 엔티티별 복제(팀 림라이트·투명도 개별 제어)
// - 클립은 루트 모션(Hips 위치 X/Z)을 제거해 제자리 재생 → 위치는 서버 스냅샷 보간이 담당
// - 비라이플 무기: 클립을 재생하지 않고 정적 '준비 자세' + 절차적 다리 스윙으로 폴백
// =====================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const DIR = (import.meta.env?.BASE_URL ?? '/') + 'models/character/';
const HEIGHT = 1.8; // 인게임 캡슐 높이(m)
const FADE = 0.15; // 클립 크로스페이드(s)

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

interface Pose { q: THREE.Quaternion[]; hips: THREE.Vector3 }
interface Assets {
  template: THREE.Group; scale: number; clips: Record<ClipKey, THREE.AnimationClip>;
  /** 준비 자세(비라이플) 서기/앉기 — 템플릿 본 순서와 동일한 인덱스 */ neutral: Pose; crouch: Pose;
  /** 무기 소켓의 오른손 로컬 변환 (조준 대기 자세에서 총구가 왼손 방향을 향하도록 보정) */ gripPos: THREE.Vector3; gripQuat: THREE.Quaternion;
  /** 부모 공간 기준 회전축: 허리 숙임(피치) · 다리 스윙 */ spineAxes: THREE.Vector3[]; legAxes: THREE.Vector3[];
}

const boneList = (root: THREE.Object3D): THREE.Bone[] => { const out: THREE.Bone[] = []; root.traverse((o) => { if ((o as THREE.Bone).isBone) out.push(o as THREE.Bone); }); return out; };
/** 같은 이름의 본이 중복될 수 있어(Spine2/Neck) 애니메이션 바인딩과 동일하게 '처음 발견된' 본을 쓴다 */
const findBone = (bones: THREE.Bone[], name: string): number => bones.findIndex((b) => b.name === 'mixamorig' + name);
const SPINE = ['Spine', 'Spine1', 'Spine2'], LEGS = ['LeftUpLeg', 'RightUpLeg'], LEFT_ARM = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'];
const LOWER = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];

/** 루트 모션 제거: Hips 위치의 X/Z 를 첫 프레임 값으로 고정. 점프 클립은 높은 곳에서 시작하므로 Y 를 서있는 높이로 클램프 */
function inPlace(clip: THREE.AnimationClip, maxY = Infinity): THREE.AnimationClip {
  for (const t of clip.tracks) {
    if (!/Hips\.position$/.test(t.name)) continue;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 1] = Math.min(v[i + 1], maxY); v[i + 2] = z0; }
  }
  return clip;
}

/** Phong(FBX 기본) → Standard: 씬의 PBR 조명과 톤을 맞추고 어둡게 뜨지 않도록 */
function toStandard(m: THREE.Material): THREE.MeshStandardMaterial {
  const p = m as THREE.MeshPhongMaterial;
  if (p.map) p.map.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.MeshStandardMaterial({ name: p.name, map: p.map, normalMap: p.normalMap, color: 0xffffff, roughness: 0.78, metalness: 0.05 });
  p.dispose(); return s;
}

/** 모델 공간 축 → 해당 본의 부모 공간 축 (템플릿은 단위 변환 상태에서 계산) */
function parentAxis(b: THREE.Bone, modelAxis: THREE.Vector3): THREE.Vector3 {
  const q = new THREE.Quaternion(); b.parent!.getWorldQuaternion(q); return modelAxis.clone().applyQuaternion(q.invert()).normalize();
}

let assetsP: Promise<Assets | null> | null = null;
export function loadCharacterAssets(): Promise<Assets | null> {
  return (assetsP ??= (async () => {
    const loader = new FBXLoader();
    const [template, ...anims] = await Promise.all([
      loader.loadAsync(DIR + 'Swat.fbx'),
      ...Object.values(CLIP_FILES).map((f) => loader.loadAsync(DIR + encodeURIComponent(f) + '.fbx')),
    ]);
    template.animations = []; // 모델 자체의 T-포즈 테이크는 사용 안 함
    template.traverse((o) => {
      const m = o as THREE.SkinnedMesh; if (!m.isMesh) return;
      m.material = Array.isArray(m.material) ? m.material.map(toStandard) : toStandard(m.material);
      m.castShadow = true; m.frustumCulled = false; // 스킨 애니메이션 시 바인드 포즈 바운딩으로 잘못 컬링되는 것 방지
    });
    // 바인드 포즈 바운딩 박스 기준: 키 1.8m, 발바닥 y=0
    template.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(template), scale = HEIGHT / (box.max.y - box.min.y);
    template.position.y = -box.min.y; // 피벗 보정은 모델 단위(cm) → 스케일은 래퍼에서 적용
    const keys = Object.keys(CLIP_FILES) as ClipKey[];
    const hipStand = 95; // 조준 대기 자세 Hips 높이(cm) 근방
    const clips = Object.fromEntries(keys.map((k, i) => [k, inPlace(anims[i].animations[0], k === 'jump' ? hipStand : Infinity)])) as Record<ClipKey, THREE.AnimationClip>;

    // ── 보정값 계산: 템플릿 복제본에 조준 대기 첫 프레임 적용 ──
    const probe = cloneSkinned(template) as THREE.Group; probe.position.set(0, 0, 0);
    const bones = boneList(probe), mixer = new THREE.AnimationMixer(probe);
    const sample = (clip: THREE.AnimationClip): Pose => {
      mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); mixer.update(0); probe.updateMatrixWorld(true);
      return { q: bones.map((b) => b.quaternion.clone()), hips: bones[0].position.clone() };
    };
    const crouchPose = sample(clips.crouch), neutral = sample(clips.idle);
    const rh = bones[findBone(bones, 'RightHand')], lh = bones[findBone(bones, 'LeftHand')], mid = bones[findBone(bones, 'RightHandMiddle1')];
    const rp = rh.getWorldPosition(new THREE.Vector3()), lp = lh.getWorldPosition(new THREE.Vector3()), rq = rh.getWorldQuaternion(new THREE.Quaternion());
    // 무기 로컬 -Z(총구)가 오른손→왼손(총열 지지) 방향, +Y 가 위를 향하는 회전
    const zAxis = rp.clone().sub(lp).normalize(), xAxis = new THREE.Vector3(0, 1, 0).cross(zAxis).normalize(), yAxis = zAxis.clone().cross(xAxis);
    const wq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    const gripQuat = rq.clone().invert().multiply(wq);
    const gripPos = rh.worldToLocal(mid.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.55); // 손목→손바닥 중앙
    const spineAxes = SPINE.map((n) => parentAxis(bones[findBone(bones, n)], new THREE.Vector3(1, 0, 0)));
    const legAxes = LEGS.map((n) => parentAxis(bones[findBone(bones, n)], new THREE.Vector3(1, 0, 0)));
    // 준비 자세 = 조준 대기 첫 프레임에서 왼팔만 바인드(T) 포즈로 되돌린 뒤 몸 옆으로 내림 (오른손은 무기를 앞으로 든 상태 유지)
    mixer.stopAllAction(); mixer.uncacheRoot(probe); // → 바인드(T) 포즈로 복원됨
    neutral.q.forEach((q, i) => { if (!LEFT_ARM.some((n) => findBone(bones, n) === i)) bones[i].quaternion.copy(q); });
    probe.updateMatrixWorld(true);
    for (const n of LEFT_ARM) neutral.q[findBone(bones, n)].copy(bones[findBone(bones, n)].quaternion);
    const la = findBone(bones, 'LeftArm');
    neutral.q[la].premultiply(new THREE.Quaternion().setFromAxisAngle(parentAxis(bones[la], new THREE.Vector3(0, 0, 1)), -1.25));
    // 앉은 준비 자세 = 준비 자세 상체 + 앉아 이동 클립 첫 프레임의 하체
    const crouch: Pose = { q: neutral.q.map((q) => q.clone()), hips: crouchPose.hips };
    for (const n of LOWER) { const i = findBone(bones, n); crouch.q[i].copy(crouchPose.q[i]); }
    return { template, scale, clips, neutral, crouch, gripPos, gripQuat, spineAxes, legAxes };
  })().catch((e) => { console.warn('[character] Swat.fbx 로드 실패 — 기본 캐릭터로 폴백', e); return null; }));
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

const _q = new THREE.Quaternion();
/** 엔티티 1개분 Swat 인스턴스 */
export class CharacterRig {
  readonly root = new THREE.Group(); // 엔티티 그룹에 붙는 래퍼 (-Z 전방 · 미터 단위)
  /** 3인칭 무기를 붙이는 소켓 (오른손 본 하위, 미터 스케일) */ readonly socket = new THREE.Group();
  private readonly model: THREE.Group;
  private readonly bones: THREE.Bone[];
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
    this.model.rotation.y = Math.PI; // Mixamo +Z 전방 → 게임 -Z 전방
    this.root.scale.setScalar(a.scale); this.root.add(this.model);
    this.bones = boneList(this.model);
    this.model.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      m.userData.entityId = entityId;
      const clone = (x: THREE.Material): THREE.MeshStandardMaterial => { const c = (x as THREE.MeshStandardMaterial).clone(); addRim(c, this.rimColor, this.rimStr); this.mats.push(c); return c; };
      m.material = Array.isArray(m.material) ? m.material.map(clone) : clone(m.material);
    });
    this.setColor(color);
    const hand = this.bones[findBone(this.bones, 'RightHand')];
    this.socket.position.copy(a.gripPos); this.socket.quaternion.copy(a.gripQuat); this.socket.scale.setScalar(1 / a.scale); hand.add(this.socket);
    this.spine = SPINE.map((n) => findBone(this.bones, n)); this.legs = LEGS.map((n) => findBone(this.bones, n));
    this.headBones = this.bones.filter((b) => /^mixamorig(Head|Neck)/.test(b.name));
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = Object.fromEntries((Object.keys(a.clips) as ClipKey[]).map((k) => {
      const act = this.mixer.clipAction(a.clips[k]);
      if (k === 'jump') { act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; }
      return [k, act];
    })) as Record<ClipKey, THREE.AnimationAction>;
  }

  /** 1인칭(본인 시점): 머리·목 본을 0 스케일로 숨겨 카메라가 헬멧/머리 메쉬에 가려지지 않게 한다 (매 프레임 애니메이션 뒤에 재적용) */
  setFirstPerson(on: boolean): void { this.fp = on; if (!on) this.headBones.forEach((b) => b.scale.setScalar(1)); }

  setColor(hex: number): void { this.rimColor.setHex(hex); }
  /** 은신/보호/시전 투명도 + 대시·회복 시 림 강조 */
  setLook(opacity: number, glow: boolean): void {
    const tr = opacity < 1;
    for (const m of this.mats) { if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; } m.opacity = opacity; m.depthWrite = !tr; }
    this.rimStr.value = glow ? 2.2 : 0.9;
  }

  private takeSnapshot(): void {
    this.snap = this.bones.map((b) => b.quaternion.clone()); this.snapHips.copy(this.bones[0].position); this.snapT = 0;
  }
  private play(k: ClipKey, timeScale: number): void {
    const act = this.actions[k]; act.timeScale = timeScale;
    if (this.cur === k) return;
    if (k === 'jump') act.reset();
    act.enabled = true; act.setEffectiveWeight(1);
    // 첫 클립은 페이드 없이(가중치<1이면 바인드 T-포즈가 섞임) — 이전 포즈와의 블렌드는 스냅샷이 담당
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
    const b = this.bones;
    if (s.rifle) {
      this.play(...this.pickClip(s)); this.mixer.update(dt);
    } else {
      // 준비 자세(서기/앉기) + 이동 시 절차적 다리 스윙 (라이플 클립은 재생하지 않음)
      const pose = s.crouch ? this.a.crouch : this.a.neutral;
      if (s.crouch !== this.wasCrouch && this.snap === null) this.takeSnapshot();
      for (let i = 0; i < b.length; i++) b[i].quaternion.copy(pose.q[i]);
      b[0].position.copy(pose.hips);
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
      b[0].position.lerpVectors(this.snapHips, b[0].position.clone(), t);
      if (t >= 1) this.snap = null;
    }
    if (this.fp) for (const hb of this.headBones) hb.scale.setScalar(0);
  }

  dispose(): void {
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
    for (const m of this.mats) m.dispose();
    this.root.removeFromParent();
  }
}
