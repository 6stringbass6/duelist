-- 카람빗 스페셜 박스 증분 마이그레이션 (supabase_schema.sql 에도 이미 반영됨). Supabase SQL Editor 에서 1회 실행, 재실행 안전.
create or replace function public.open_lootbox(p_box_id text default 'standard', p_use_owned boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_box lootboxes; v_p profiles; v_total numeric; v_roll numeric; v_acc numeric := 0;
        r record; v_rarity text; v_refund int := 0; v_skin skin_catalog; v_dup boolean; v_new text[]; v_gun_only boolean := (p_box_id = 'karambit');
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_box from lootboxes where box_id = p_box_id and active;
  if not found then raise exception 'BOX_NOT_FOUND'; end if;
  select * into v_p from profiles where id = v_uid for update;
  if p_use_owned then
    -- 보유 박스(미션/로그인 보상)는 스탠다드 전용 — 스페셜 박스는 크레딧 결제만
    if p_box_id = 'karambit' then raise exception 'NO_LOOTBOX'; end if;
    if v_p.lootboxes < 1 then raise exception 'NO_LOOTBOX'; end if;
    update profiles set lootboxes = lootboxes - 1 where id = v_uid;
  else
    if v_p.credits < v_box.price then raise exception 'NOT_ENOUGH_CREDITS'; end if;
    update profiles set credits = credits - v_box.price where id = v_uid;
  end if;
  select coalesce(sum(weight), 0) into v_total from lootbox_rates where box_id = p_box_id and weight > 0;
  if v_total <= 0 then raise exception 'BOX_MISCONFIGURED'; end if;
  v_roll := random() * v_total;
  -- rarity = 등급(select..ultra) 또는 특수 칸 'karambit'(단일 스킨 잭팟, dup_refund = 중복 환급액)
  for r in select * from lootbox_rates where box_id = p_box_id and weight > 0 order by weight desc, rarity loop
    v_acc := v_acc + r.weight; v_rarity := r.rarity; v_refund := r.dup_refund;
    exit when v_roll <= v_acc;
  end loop;
  if v_rarity = 'karambit' then
    select * into v_skin from skin_catalog where skin_id in ('karambit_dagger','karambit_doppler','karambit_doppler_sapphire','karambit_gamma_doppler') and active order by random() limit 1; -- 표면 경화 / 도플러 / 사파이어 / 에메랄드 균등 분할
  else
    select * into v_skin from skin_catalog where rarity = v_rarity and in_box and active
      and (not v_gun_only or weapon_id not in ('dagger','sword')) order by random() limit 1;
  end if;
  if not found then
    select * into v_skin from skin_catalog where in_box and active and (not v_gun_only or weapon_id not in ('dagger','sword')) order by random() limit 1;
    if not found then raise exception 'BOX_EMPTY'; end if;
    select coalesce((select dup_refund from lootbox_rates where box_id = p_box_id and rarity = v_skin.rarity), 0) into v_refund;
  end if;
  v_dup := exists (select 1 from user_skins where user_id = v_uid and skin_id = v_skin.skin_id);
  if v_dup then update profiles set credits = credits + v_refund where id = v_uid;
  else insert into user_skins (user_id, skin_id, weapon_id, source) values (v_uid, v_skin.skin_id, v_skin.weapon_id, 'box'); end if;
  v_new := check_achievements(v_uid);
  select * into v_p from profiles where id = v_uid;
  return jsonb_build_object('skin_id', v_skin.skin_id, 'weapon_id', v_skin.weapon_id, 'rarity', v_skin.rarity, 'duplicate', v_dup,
                            'refund', case when v_dup then v_refund else 0 end, 'credits', v_p.credits, 'lootboxes', v_p.lootboxes,
                            'jackpot', (v_rarity = 'karambit'), 'unlocked', to_jsonb(v_new));
end $$;

insert into public.lootboxes (box_id, name, price) values ('karambit','카람빗 스페셜 박스',4000)
on conflict (box_id) do update set name = excluded.name, price = excluded.price, active = true;
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort)
values ('karambit_dagger','dagger','카람빗','exrare',4500,false,false,false,14)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = false, in_daily = false, in_box = false, sort = excluded.sort, active = true;
insert into public.lootbox_rates (box_id, rarity, weight, dup_refund) values
  ('karambit','karambit',0.1,2000),('karambit','covert',19.9,900),('karambit','classified',23.33,550),('karambit','restricted',41.67,375),('karambit','milspec',15,225),('karambit','industrial',0,150),('karambit','consumer',0,150)
on conflict (box_id, rarity) do update set weight = excluded.weight, dup_refund = excluded.dup_refund;
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort)
values ('karambit_doppler','dagger','★ 카람빗 | 도플러','exrare',4500,false,false,false,14.5)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = false, in_daily = false, in_box = false, sort = excluded.sort, active = true;
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort) values
  ('karambit_doppler_sapphire','dagger','★ 카람빗 | 사파이어','exrare',4500,false,false,false,14.6),
  ('karambit_gamma_doppler','dagger','★ 카람빗 | 에메랄드','exrare',4500,false,false,false,14.7)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = false, in_daily = false, in_box = false, sort = excluded.sort, active = true;
