-- 정상 완주한 모든 매치(사격장·비공개 방 제외, apply_match_result 가 match_history 를 쓰는 경로)마다 드롭 무기 상자 +1.
-- 기존 "주 1회 첫 레벨업 지급" 조건 제거. 탈주('left')는 XP·상자 모두 0.
-- match_history 행 1개 = 상자 1개 (서버 persist 는 e.persisted 플래그로 선수당 1회만 호출 → 멱등).
create or replace function public.match_xp_drop() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_gain int;
begin
  if new.result = 'left' then return new; end if;
  v_gain := 100 + 10 * greatest(new.kills, 0) + case when new.result = 'win' then 100 else 0 end;
  update profiles set xp = xp + v_gain, lootboxes = lootboxes + 1 where id = new.user_id;
  return new;
end $$;
revoke execute on function public.match_xp_drop() from public, anon, authenticated;
