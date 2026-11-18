# 상점 · 컨테이너 개편 체크포인트

다음 세션은 이 파일을 읽고 미완료 Phase 부터 재개할 것.

- [x] Phase 1 완료 — 데이터/경제 엔진 + 오늘의 상점(4칸) + 상설 판매 + 보관함 `컨테이너`
- [x] Phase 2 완료 — CS2 가로 룰렛 개봉 연출 + [개별 스킵]/[일괄 스킵]
  - `client/src/game/caseOpening.ts` (신규): 인트로(열쇠·뚜껑) → rAF 룰렛(ease-out quart, 기준선 통과 시 Web Audio 틱, 속도 비례 피치) → 하이라이트 → 요약 그리드. ★ 칸은 황금 별 실루엣
  - `client/src/main.ts`: `openCaseFlow` 가 `runCaseOpening` 호출, 상점 컨테이너 카드에 '열기' 버튼
  - `client/index.html`: `.co-*` 모달 CSS (모바일 720px 분기, reduced-motion)
- [ ] Phase 3 — Playwright 실물 검증 후 이 파일 삭제 · 커밋 · 푸시

## Phase 1 수정 파일
- `supabase_shop_overhaul.sql` (신규) — profiles.case_keys/store_cases/xp/last_drop_week, RPC `buy_store_item`, `open_cases`, `get_daily_shop`·`buy_skin` 교체, match_history XP 트리거(주간 드롭). **원격 DB 반영은 `npm run db:push` 필요 (.env.local 의 SUPABASE_DB_URL)**
- `client/src/config/skins.ts` — `CASES`, `SHOP_PRICES`, `BUY_QTYS`, `rollCaseTier`, `caseOdds`, `matchXp`
- `client/src/services/economy.ts` (신규) — 계정=RPC / 게스트=localStorage 엔진, 오늘의 상점 날짜 시드, 개봉·구매·XP
- `client/src/services/supabase.ts` — Profile 경제 필드, 게스트 경제 로컬 저장(시작 1,000 크레딧), 오류코드, `rpc` export
- `client/src/main.ts` — 상점 탭 전면 교체(열쇠&컨테이너 / 오늘의 상점 / 상설 판매), 보관함 `컨테이너` 슬롯(htmlContainers), 구 가챠 제거
- `client/index.html` — 상점/컨테이너 CSS

## 메모
- 드롭 무기 상자 = 기존 `profiles.lootboxes` 컬럼 재사용(미션·출석 보상도 드롭 상자로 지급)
- 개봉 진입점: `main.ts` 의 `openCaseFlow(kind, n)` — Phase 2 에서 룰렛 모달로 교체 예정
