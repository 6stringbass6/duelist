// =====================================================================
// 스킬 카탈로그 (server/server.js 의 SKILLS / ULTS 와 수치 동일 유지). 서버가 판정 권위.
// Q·E 슬롯에는 일반 스킬 7종 중 아무거나(중복 불가), X 슬롯에는 궁극기 3종 중 1개를 장착한다.
// =====================================================================

export type SkillId = 'updraft' | 'haste' | 'amp' | 'suppress' | 'heal' | 'barrier' | 'shield';
export type UltId = 'omen' | 'yoru' | 'iso';

export interface SkillDef { id: SkillId; name: string; icon: string; desc: string; cdMs: number; uses: number; durMs?: number }
export interface UltDef { id: UltId; name: string; icon: string; desc: string }

export const SKILLS: Record<SkillId, SkillDef> = {
  updraft:  { id: 'updraft',  name: '상승기류',     icon: '⇧', cdMs: 7000,  uses: 3, desc: '수직 상방으로 강하게 도약합니다.' },
  haste:    { id: 'haste',    name: '이속 증가',    icon: '»', cdMs: 8000,  uses: 2, durMs: 5000, desc: '5초간 이동 속도가 증가합니다.' },
  amp:      { id: 'amp',      name: '데미지 증폭',  icon: '✦', cdMs: 12000, uses: 2, durMs: 5000, desc: '5초간 총기 데미지 1.4배 (붉은 오라).' },
  suppress: { id: 'suppress', name: '제로/포인트',  icon: '⌖', cdMs: 15000, uses: 2, desc: '억제 나이프 투척. 착탄 지점 반경 12m 내 적의 Q/E/X 스킬을 8초간 봉인합니다.' },
  heal:     { id: 'heal',     name: '치유',         icon: '✚', cdMs: 18000, uses: 2, durMs: 4000, desc: '4초에 걸쳐 체력 최대 60 회복. 회복 중 피격되면 중단됩니다.' },
  barrier:  { id: 'barrier',  name: '장벽',         icon: '▮', cdMs: 14000, uses: 2, desc: '조준한 바닥에 장벽 생성. 시야·이동을 막고 총격으로 파괴할 수 있습니다.' },
  shield:   { id: 'shield',   name: '보호막',       icon: '◈', cdMs: 20000, uses: 1, durMs: 10000, desc: '10초간 적 처치 시 에너지 구슬 생성. 구슬을 쏘거나 접촉하면 1회 피격을 완전 무효화합니다.' },
};
export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

export const ULTS: Record<UltId, UltDef> = {
  omen: { id: 'omen', name: '그림자 습격', icon: '☄', desc: '전술 맵에서 지정한 좌표로 순간이동합니다. 시전(1.5초) 중 피격되면 취소됩니다.' },
  yoru: { id: 'yoru', name: '차원 표류',   icon: '◌', desc: '7초간 무적·은신 상태로 빠르게 이동합니다. 은신 중 공격 불가, 해제 시 짧은 후딜레이.' },
  iso:  { id: 'iso',  name: '청부 계약',   icon: '⚔', desc: '전방 직선 파동에 적중한 적 1명과 함께 격리 아레나로 이동해 15초간 1:1 결투. 승자만 원래 위치로 복귀합니다.' },
};
export const ULT_IDS = Object.keys(ULTS) as UltId[];
export const ULT_COST = 6;

export const DEFAULT_SKILLS = { q: 'updraft' as SkillId, e: 'haste' as SkillId, x: 'omen' as UltId };
