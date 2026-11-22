// =====================================================================
// 1인칭 카람빗 뷰모델 애니메이션 (CS 1.6 / CS:GO 포팅 v_knife.mdl 에서 추출한 모션만 사용 — 구형 손/칼 메쉬는 렌더하지 않음)
// - models/animations/karambit_anims.glb: 메쉬 없는 MDL 본 계층(R_Forearm → R_Hand → 손가락 15개, v_weapon → knife)과
//   시퀀스(idle · draw · slash1/2 · stab · inspect …) TRS 트랙
// - MDL 루트는 카메라 자식(뷰모델 공간: X 전방 · Y 왼쪽 · Z 위, 단위 ≈ 인치) → 매 프레임 본 월드 포즈를
//   요원 리그의 오른팔 IK 목표(손목·팔꿈치·손가락 방향)와 카람빗 GLB 의 월드 변환으로 넘긴다
// =====================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getSkin } from '../config/skins';

const URL = (import.meta.env?.BASE_URL ?? '/') + 'models/animations/karambit_anims.glb';
/** MDL 단위 → m (MDL 칼 길이 9.8u ↔ 카람빗 GLB 0.27m) */
const UNIT = 0.27 / 9.8;
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
/** MDL 뷰모델 공간 → 카메라 공간(-Z 전방 · +X 오른쪽 · +Y 위) */
const MAP = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(0, 0, -1), V(-1, 0, 0), V(0, 1, 0)));
/** 무기 그룹 축(날끝 -Z · 휜 날 +Y · Play Side -X) → MDL knife 본 로컬 축(링→날끝 +Y · 휜 날 +Z · 카메라를 보는 면 +X).
 *  카람빗 GLB 는 CS:GO 원본과 거울상(같은 휨에서 Play Side 가 반대편)이라 두께축(X) 반사(KNIFE_SCALE)까지 더해야
 *  휨 방향과 Play Side 가 동시에 맞는다 */
const KNIFE_AXES = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(V(1, 0, 0), V(0, 0, 1), V(0, -1, 0)));
const KNIFE_SCALE = V(-1, 1, 1);
/** 무기 그룹 원점(뒤끝에서 30% 그립 지점 · 단면 중심) 의 MDL knife 로컬 좌표(u) */
const KNIFE_ORIGIN = V(0.28, -4.44 + 9.8 * 0.3, 2.4);
/** 자세히 보기 손바닥 지지 구간: 칼 그립 중심 ↔ 손 평면(손바닥 법선 +Y) 최소 거리(u).
 *  쥔 상태 = 손가락이 감싸므로 얕게, 손을 펼친 상태 = CS2 장갑 손바닥 두께 + 손잡이 반두께만큼 띄워 관통 방지 */
const PALM_CLEAR_GRIP = 0.3, PALM_CLEAR_OPEN = 0.95;
/** 손가락 펼침 정도(검지~새끼 마디 방향 · 손 전방 평균 내적): 이 구간에서 쥔(0) → 펼친(1) 으로 보간 */
const OPEN_LO = -0.3, OPEN_HI = -0.15;

/** 카람빗 스킨(표면 경화 · 도플러 3종 · 다마스커스 · 골드 룬 …) 여부 — 모두 같은 그룹 축 규약을 공유 */
export const isKarambitSkin = (skinId: string | null | undefined): boolean => getSkin(skinId)?.collection === 'karambit';

/** 손가락 체인: [엄지, 검지, 중지, 약지, 새끼] × 3마디 (CS2 finger_*_0..2_r 와 같은 순서) */
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
const MDL_FINGER = (f: number, j: number): string => `R_Finger${f}${j || ''}`; // Finger1 → Finger11 → Finger12

export interface ArmTarget {
  /** 손목 월드 위치 · 팔꿈치 힌트(폴) */ hand: THREE.Vector3; elbow: THREE.Vector3;
  /** MDL 손 월드 회전 + 손 기하 프레임(로컬: x=중지 방향, z=검지←새끼 측면) */ handQuat: THREE.Quaternion; handFrame: THREE.Quaternion;
  /** 손가락 마디별 월드 방향 [f*3+j] */ fingers: THREE.Vector3[];
}

type Clip = 'idle' | 'draw' | 'slash1' | 'slash2' | 'stab' | 'inspect';
let srcP: Promise<{ scene: THREE.Group; clips: Map<string, THREE.AnimationClip> } | null> | null = null;
const loadSrc = () =>
  (srcP ??= new GLTFLoader().loadAsync(URL).then(
    (g) => ({ scene: g.scene, clips: new Map(g.animations.map((a) => [a.name, a])) }),
    (e) => { console.warn('[karambit] 애니메이션 로드 실패', e); return null; },
  ));

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _hp = new THREE.Vector3(), _ax = new THREE.Vector3(), _fq = new THREE.Quaternion();

export class KarambitViewmodel {
  readonly root = new THREE.Group();
  readonly target: ArmTarget;
  private readonly mixer: THREE.AnimationMixer;
  private readonly acts = new Map<Clip, THREE.AnimationAction>();
  private readonly hand: THREE.Object3D; private readonly elbow: THREE.Object3D; private readonly knife: THREE.Object3D;
  private readonly fingerNodes: THREE.Object3D[];
  private cur: Clip | null = null; private flip = false;
  /** MDL 손목→중지 뿌리 거리(u) */ private readonly mdlSpan: number;

  private constructor(scene: THREE.Group, clips: Map<string, THREE.AnimationClip>) {
    const s = scene.clone(true); this.root.add(s);
    this.root.quaternion.copy(MAP); this.root.scale.setScalar(UNIT); // MDL 원점 = 눈 위치
    const node = (n: string): THREE.Object3D => { const o = s.getObjectByName(n); if (!o) throw new Error('[karambit] 본 없음 ' + n); return o; };
    this.hand = node('R_Hand'); this.elbow = node('R_Forearm'); this.knife = node('knife');
    this.fingerNodes = FINGERS.flatMap((_, f) => [0, 1, 2].map((j) => node(MDL_FINGER(f, j))));
    // MDL 손 기하 프레임: 손목→중지 뿌리(x) · 새끼→검지(z 측면)
    const mid = node('R_Finger2').position, idx = node('R_Finger1').position, pin = node('R_Finger4').position;
    this.mdlSpan = mid.length();
    this.target = { hand: new THREE.Vector3(), elbow: new THREE.Vector3(), handQuat: new THREE.Quaternion(), handFrame: handFrame(mid, idx.clone().sub(pin)), fingers: this.fingerNodes.map(() => new THREE.Vector3()) };
    this.mixer = new THREE.AnimationMixer(s);
    const map: Record<Clip, string> = { idle: 'idle', draw: 'draw', slash1: 'slash1', slash2: 'slash2', stab: 'stab', inspect: 'inspect' };
    for (const [k, n] of Object.entries(map) as [Clip, string][]) {
      const c = clips.get(n); if (!c) continue;
      const a = this.mixer.clipAction(c);
      if (k !== 'idle') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      if (k === 'slash1' || k === 'slash2' || k === 'stab') a.timeScale = 1.35; // 단검 연타(300ms) 템포에 맞춰 약간 빠르게
      this.acts.set(k, a);
    }
    this.mixer.addEventListener('finished', (e) => { if ((e as unknown as { action: THREE.AnimationAction }).action === this.acts.get(this.cur!)) this.play('idle', 0.2); });
  }

  static async create(): Promise<KarambitViewmodel | null> { const s = await loadSrc(); return s ? new KarambitViewmodel(s.scene, s.clips) : null; }

  get inspecting(): boolean { return this.cur === 'inspect'; }

  private play(k: Clip, fade = 0.08): void {
    const next = this.acts.get(k); if (!next) return;
    const prev = this.cur ? this.acts.get(this.cur) : null;
    next.reset().setEffectiveWeight(1).play();
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
    this.cur = k;
  }
  /** 3번 장착: 꺼내기 → idle */ draw(): void { this.play('draw', 0); }
  /** 좌클릭: 가로 베기(좌/우 교대) */ slash(): void { this.flip = !this.flip; this.play(this.flip ? 'slash1' : 'slash2'); }
  /** 우클릭: 역수 찌르기 */ stab(): void { this.play('stab'); }
  /** F: 자세히 보기(핑거 링 회전) — 다시 누르면 처음부터 */ inspect(): void { this.play('inspect', 0.15); }

  /** 애니메이션 진행 + 월드 목표 갱신 (root 의 부모(카메라) 월드 행렬이 최신이어야 함) */
  update(dt: number): void {
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    const t = this.target;
    this.hand.matrixWorld.decompose(t.hand, t.handQuat, _s);
    t.elbow.setFromMatrixPosition(this.elbow.matrixWorld);
    this.fingerNodes.forEach((n, i) => t.fingers[i].setFromMatrixColumn(n.matrixWorld, 0).normalize()); // GoldSrc 본은 로컬 +X 로 뻗는다
  }

  /** 카람빗 그룹(무기 메쉬)의 월드 변환: 실제 손목 위치(IK 결과) + MDL 손목→칼 오프셋(손 크기 비율로 축척 → 작은 장갑도 손잡이를 감싸 쥠) */
  knifeWorld(handPos: THREE.Vector3, handSpan: number, out: THREE.Matrix4): THREE.Matrix4 {
    this.knife.matrixWorld.decompose(_p, _q, _s);
    const k = handSpan / (this.mdlSpan * UNIT);
    _hp.copy(KNIFE_ORIGIN).multiplyScalar(UNIT).applyQuaternion(_q).add(_p).sub(this.target.hand).multiplyScalar(k);
    this.palmLift(_hp, k);
    return out.compose(_hp.add(handPos), _q.multiply(KNIFE_AXES), KNIFE_SCALE);
  }

  /** 자세히 보기 중 손바닥 관통 방지: 손목→그립 오프셋 off(m)를 손바닥 법선 방향으로 최소 거리까지 밀어낸다.
   *  MDL 원본 손(CS 1.6)보다 CS2 장갑이 두꺼워 펼친 손바닥 위를 지나는 손잡이가 손 안으로 파고드는 구간만 보정(쥔 자세는 그대로) */
  private palmLift(off: THREE.Vector3, k: number): void {
    const w = this.cur === 'inspect' ? (this.acts.get('inspect')?.getEffectiveWeight() ?? 0) : 0; if (w <= 0) return;
    const t = this.target; _fq.copy(t.handQuat).multiply(t.handFrame);
    _ax.set(1, 0, 0).applyQuaternion(_fq);
    let open = 0; for (let i = 3; i < t.fingers.length; i++) open += t.fingers[i].dot(_ax); // 엄지 제외 12마디
    const o = THREE.MathUtils.smoothstep(open / (t.fingers.length - 3), OPEN_LO, OPEN_HI);
    const n = _ax.set(0, 1, 0).applyQuaternion(_fq), need = THREE.MathUtils.lerp(PALM_CLEAR_GRIP, PALM_CLEAR_OPEN, o) * UNIT * k;
    const d = off.dot(n); if (d < need) off.addScaledVector(n, (need - d) * w);
  }

  dispose(): void { this.mixer.stopAllAction(); this.root.removeFromParent(); }
}

/** 손 기하 프레임(로컬): x = 손목→중지 뿌리, z = 새끼→검지 측면(직교화), y = z × x */
export function handFrame(toMiddle: THREE.Vector3, side: THREE.Vector3): THREE.Quaternion {
  const x = toMiddle.clone().normalize(), z = side.clone().addScaledVector(x, -side.dot(x)).normalize(), y = z.clone().cross(x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
