-- 버터플라이 나이프(단검 전용 GLB 스킨) — 상점 NEW(featured) 상시 판매, 울트라 4,500 크레딧
-- 적용: npm run db:push  (또는 Supabase SQL Editor 에서 실행)
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort)
values ('butterfly_dagger','dagger','버터플라이 나이프','exrare',4500,true,false,false,15)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = true, in_daily = false, in_box = false, sort = excluded.sort, active = true;
