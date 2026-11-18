-- 스켈레톤 나이프(단검 전용 GLB 스킨) — 상점 NEW(featured) 상시 판매, 울트라 4,500 크레딧
-- 적용: npm run db:push  (또는 Supabase SQL Editor 에서 실행)
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort)
values ('skeleton_dagger','dagger','스켈레톤 나이프','ultra',4500,true,false,false,16)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = true, in_daily = false, in_box = false, sort = excluded.sort, active = true;

-- 카람빗 모델 교체(FBX)에 맞춰 표시명 정리 (케이스 하드닝 → 카람빗)
update public.skin_catalog set name = '카람빗' where skin_id = 'karambit_dagger';
