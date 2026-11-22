-- 상자·열쇠 구매/개봉 수량 제한 완화 (1~999). Supabase SQL Editor 에서 1회 실행, 재실행 안전.
-- 열쇠 / 상점 전용 컨테이너 구매 (수량 1~999)
create or replace function public.buy_store_item(p_item text, p_qty int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_unit int; v_p profiles;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_qty not between 1 and 999 then raise exception 'INVALID_QTY'; end if;
  v_unit := case p_item when 'key' then 1500 when 'store_case' then 2200 end;
  if v_unit is null then raise exception 'NOT_FOR_SALE'; end if;
  select * into v_p from profiles where id = v_uid for update;
  if v_p.credits < v_unit * p_qty then raise exception 'NOT_ENOUGH_CREDITS'; end if;
  update profiles set credits = credits - v_unit * p_qty,
    case_keys = case_keys + case when p_item = 'key' then p_qty else 0 end,
    store_cases = store_cases + case when p_item = 'store_case' then p_qty else 0 end
  where id = v_uid returning * into v_p;
  return jsonb_build_object('credits', v_p.credits, 'lootboxes', v_p.lootboxes, 'case_keys', v_p.case_keys, 'store_cases', v_p.store_cases);
end $$;

-- 컨테이너 개봉 (drop = 드롭 무기 상자 + 열쇠 1개씩 / store = 열쇠 동봉). 중복은 기준가 25% 환급
create or replace function public.open_cases(p_case text, p_count int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_p profiles; v_rarity text; v_skin skin_catalog; v_dup boolean; v_refund int;
        v_out jsonb := '[]'::jsonb; v_new text[]; i int;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_count not between 1 and 999 then raise exception 'INVALID_QTY'; end if;
  select * into v_p from profiles where id = v_uid for update;
  if p_case = 'drop' then
    if v_p.lootboxes < p_count then raise exception 'NO_LOOTBOX'; end if;
    if v_p.case_keys < p_count then raise exception 'NO_CASE_KEY'; end if;
    update profiles set lootboxes = lootboxes - p_count, case_keys = case_keys - p_count where id = v_uid;
  elsif p_case = 'store' then
    if v_p.store_cases < p_count then raise exception 'NO_LOOTBOX'; end if;
    update profiles set store_cases = store_cases - p_count where id = v_uid;
  else raise exception 'BOX_NOT_FOUND'; end if;
  for i in 1..p_count loop
    v_rarity := case_roll(p_case);
    select * into v_skin from skin_catalog where rarity = v_rarity and active order by random() limit 1;
    if not found then raise exception 'BOX_EMPTY'; end if;
    v_dup := exists (select 1 from user_skins where user_id = v_uid and skin_id = v_skin.skin_id);
    v_refund := case v_rarity when 'milspec' then 225 when 'restricted' then 375 when 'classified' then 550 when 'covert' then 900 when 'exrare' then 1125 else 0 end;
    if v_dup then update profiles set credits = credits + v_refund where id = v_uid;
    else insert into user_skins (user_id, skin_id, weapon_id, source) values (v_uid, v_skin.skin_id, v_skin.weapon_id, 'box'); end if;
    v_out := v_out || jsonb_build_object('skin_id', v_skin.skin_id, 'weapon_id', v_skin.weapon_id, 'rarity', v_rarity,
                                         'duplicate', v_dup, 'refund', case when v_dup then v_refund else 0 end);
  end loop;
  v_new := check_achievements(v_uid);
  select * into v_p from profiles where id = v_uid;
  return jsonb_build_object('results', v_out, 'credits', v_p.credits, 'lootboxes', v_p.lootboxes, 'case_keys', v_p.case_keys,
                            'store_cases', v_p.store_cases, 'unlocked', to_jsonb(v_new));
end $$;
