-- =====================================================================
-- 상점 · 컨테이너 개편 (npm run db:push 로 적용, 재실행 안전)
--  · 드롭 무기 상자(profiles.lootboxes 재사용) + 무기 상자 열쇠(case_keys) + 상점 전용 컨테이너(store_cases)
--  · 오늘의 상점 4칸: 군용/제한된/비밀의 무기만 (1,100 / 1,800 / 2,800)
--  · 상설 판매: 평범한/쓸만한 무기 (400 / 700)
--  · 매치 XP 레벨업 시 주 1회 드롭 무기 상자 지급 (match_history 트리거)
-- 확률/가격 상수는 client/src/config/skins.ts 의 CASES · SHOP_PRICES 와 반드시 동일하게 유지할 것.
-- =====================================================================

alter table public.profiles add column if not exists case_keys int not null default 0 check (case_keys >= 0);
alter table public.profiles add column if not exists store_cases int not null default 0 check (store_cases >= 0);
alter table public.profiles add column if not exists xp int not null default 0 check (xp >= 0);
alter table public.profiles add column if not exists last_drop_week text;

-- 상점 가격표 (등급 → 크레딧). null = 해당 판매처에서 취급 안 함
create or replace function public.shop_price(p_rarity text, p_daily boolean) returns int
language sql immutable as $$
  select case when p_daily then case p_rarity when 'milspec' then 1100 when 'restricted' then 1800 when 'classified' then 2800 end
              else case p_rarity when 'consumer' then 400 when 'industrial' then 700 end end
$$;

-- 컨테이너 등급 추첨 (CS2 공식 확률)
create or replace function public.case_roll(p_case text) returns text
language plpgsql volatile as $$
declare v numeric := random() * 100;
begin
  if p_case = 'drop' then
    if v < 0.26 then return 'exrare'; end if; v := v - 0.26;
    if v < 0.64 then return 'covert'; end if; v := v - 0.64;
    if v < 3.20 then return 'classified'; end if; v := v - 3.20;
    if v < 15.98 then return 'restricted'; end if;
    return 'milspec';
  elsif p_case = 'store' then
    if v < 5 then return 'classified'; end if; v := v - 5;
    if v < 20 then return 'restricted'; end if;
    return 'milspec';
  end if;
  raise exception 'BOX_NOT_FOUND';
end $$;

-- 오늘의 상점: 4칸, 최고 비밀의 무기. 구버전 진열(다른 등급/가격)이 남아 있으면 오늘 것만 재생성
create or replace function public.get_daily_shop()
returns table (slot smallint, skin_id text, price int, owned boolean)
language plpgsql security definer set search_path = public as $$
declare v_today date := kst_today();
begin
  perform pg_advisory_xact_lock(hashtext('daily_shop'));
  if exists (select 1 from daily_shop d join skin_catalog c using (skin_id)
             where d.shop_date = v_today and (shop_price(c.rarity, true) is null or d.price <> shop_price(c.rarity, true))) then
    delete from daily_shop d where d.shop_date = v_today;
  end if;
  if not exists (select 1 from daily_shop d where d.shop_date = v_today) then
    insert into daily_shop (shop_date, slot, skin_id, price)
    select v_today, row_number() over (), s.skin_id, shop_price(s.rarity, true)
    from (select c.skin_id, c.rarity from skin_catalog c where c.active and c.rarity in ('milspec','restricted','classified') order by random() limit 4) s;
  end if;
  return query
    select d.slot, d.skin_id, d.price,
           exists (select 1 from user_skins u where u.user_id = auth.uid() and u.skin_id = d.skin_id)
    from daily_shop d where d.shop_date = v_today order by d.slot;
end $$;

-- 스킨 직접 구매: 오늘의 상점 또는 상설 판매(평범한·쓸만한)만. Featured 직판 폐지
create or replace function public.buy_skin(p_skin_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_c skin_catalog; v_price int; v_src text; v_p profiles; v_new text[];
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_c from skin_catalog where skin_id = p_skin_id and active;
  if not found then raise exception 'SKIN_NOT_FOUND'; end if;
  select d.price into v_price from daily_shop d where d.shop_date = kst_today() and d.skin_id = p_skin_id;
  if v_price is not null then v_src := 'shop';
  else v_price := shop_price(v_c.rarity, false); v_src := 'store';
    if v_price is null then raise exception 'NOT_FOR_SALE'; end if;
  end if;
  select * into v_p from profiles where id = v_uid for update;
  if exists (select 1 from user_skins where user_id = v_uid and skin_id = p_skin_id) then raise exception 'ALREADY_OWNED'; end if;
  if v_p.credits < v_price then raise exception 'NOT_ENOUGH_CREDITS'; end if;
  update profiles set credits = credits - v_price where id = v_uid returning * into v_p;
  insert into user_skins (user_id, skin_id, weapon_id, source) values (v_uid, p_skin_id, v_c.weapon_id, v_src);
  v_new := check_achievements(v_uid);
  return jsonb_build_object('skin_id', p_skin_id, 'credits', v_p.credits, 'unlocked', to_jsonb(v_new));
end $$;

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

-- 매치 XP: 기본 100 + 킬 10 + 승리 100 (이탈 0). 1,000 XP = 1 레벨. 이번 주(KST, ISO 주) 첫 레벨업 시 드롭 무기 상자 1개
create or replace function public.match_xp_drop() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_gain int; v_old int; v_week text := to_char((now() at time zone 'Asia/Seoul')::date, 'IYYY-IW');
begin
  if new.result = 'left' then return new; end if;
  v_gain := 100 + 10 * greatest(new.kills, 0) + case when new.result = 'win' then 100 else 0 end;
  select xp into v_old from profiles where id = new.user_id for update;
  update profiles set xp = xp + v_gain,
    lootboxes = lootboxes + case when (v_old + v_gain) / 1000 > v_old / 1000 and last_drop_week is distinct from v_week then 1 else 0 end,
    last_drop_week = case when (v_old + v_gain) / 1000 > v_old / 1000 then v_week else last_drop_week end
  where id = new.user_id;
  return new;
end $$;
drop trigger if exists match_xp_drop on public.match_history;
create trigger match_xp_drop after insert on public.match_history for each row execute function public.match_xp_drop();

revoke execute on function public.shop_price(text, boolean), public.case_roll(text), public.match_xp_drop() from public, anon, authenticated;
grant execute on function public.buy_store_item(text, int), public.open_cases(text, int), public.get_daily_shop(), public.buy_skin(text) to authenticated;
