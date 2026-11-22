// =====================================================================
// 요원(Agent) 마스터 데이터 — 진영(CT / T)별 3인칭 캐릭터 모델
//  - 팀 0 = 대테러리스트(CT), 팀 1 = 테러리스트(T)
//  - 로드아웃에 진영별 장착 요원(agentCt / agentT)을 저장, 서버 SERVER_AGENTS(server.js)와 ID 동일 유지
//  - 새 요원 추가: AGENTS 에 항목 추가 + server.js AGENT_POOL 에 ID 등록 → 보관함 카드 그리드에 자동 표시
// =====================================================================

export type Side = 'ct' | 't';
export type AgentId = 'ct_sas' | 't_phoenix';

/** 1인칭 팔은 별도 메쉬 없이 요원 GLB 의 팔·장갑·소매를 그대로 쓴다(트루 1인칭 리그) — 손목 기준 좌표는 CharacterRig.wrists(weapon_hand_r/l 본) */
export interface AgentDef {
  id: AgentId; side: Side; name: string; en: string; desc: string;
  /** 카드 모노그램용 짧은 라틴 약칭 (3~4자) */ tag: string;
  /** public/ 기준 GLB 경로 */ model: string;
}

export const SIDES: Record<Side, { team: 0 | 1; name: string; en: string; code: string; color: string }> = {
  ct: { team: 0, name: '대테러리스트', en: 'Counter-Terrorist', code: 'CT', color: '#6aa6e8' },
  t: { team: 1, name: '테러리스트', en: 'Terrorist', code: 'T', color: '#e06b4a' },
};

export const AGENTS: Record<AgentId, AgentDef> = {
  ct_sas: {
    id: 'ct_sas', side: 'ct', name: 'SAS', tag: 'SAS', en: 'Special Air Service', model: 'models/agents/ct_sas.glb',
    desc: '방독면과 다크 네이비 전술복을 갖춘 영국 특수부대 요원. 하드너클 장갑을 착용합니다.',
  },
  t_phoenix: {
    id: 't_phoenix', side: 't', name: '피닉스 커넥션', tag: 'PHX', en: 'Phoenix Connexion', model: 'models/agents/t_phoenix.glb',
    desc: '발라클라바를 쓴 무장 조직 피닉스의 행동대원. 걷어 올린 소매와 전술 장갑이 특징입니다.',
  },
};

export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];
export const DEFAULT_AGENT: Record<Side, AgentId> = { ct: 'ct_sas', t: 't_phoenix' };
export const agentsForSide = (side: Side): AgentDef[] => AGENT_IDS.map((id) => AGENTS[id]).filter((a) => a.side === side);
export const sideOfTeam = (team: number | undefined): Side => (team === 1 ? 't' : 'ct');

/** 저장값 검증 + 마이그레이션: 알 수 없는 ID(삭제된 구형 요원 등)·다른 진영 ID는 해당 진영 기본 요원으로 */
export function resolveAgent(id: unknown, side: Side): AgentId {
  return typeof id === 'string' && Object.hasOwn(AGENTS, id) && AGENTS[id as AgentId].side === side ? (id as AgentId) : DEFAULT_AGENT[side];
}
/** 엔티티(플레이어/봇)의 현재 진영에 맞는 장착 요원 */
export function agentFor(team: number | undefined, loadout: { agentCt?: unknown; agentT?: unknown } | null | undefined): AgentId {
  const side = sideOfTeam(team);
  return resolveAgent(side === 'ct' ? loadout?.agentCt : loadout?.agentT, side);
}
