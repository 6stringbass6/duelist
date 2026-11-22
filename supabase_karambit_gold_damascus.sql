-- 카람빗 골드 룬 / 다마스커스 강철 스킨을 skin_catalog 에 등록 (개발자 지급 `admin:skin:grant` 는 이 테이블의 active 행만 지급한다)
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전(idempotent).
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort) values
  ('karambit_gold_runes','dagger','★ 카람빗 | 골드 룬','exrare',4500,false,false,false,14.8),
  ('karambit_damascus_steel','dagger','★ 카람빗 | 다마스커스 강철','exrare',4500,false,false,false,14.9)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = false, in_daily = false, in_box = false, sort = excluded.sort, active = true;

-- 확인용: 두 행이 active = true 로 보여야 한다
select skin_id, name, rarity, active from public.skin_catalog where skin_id in ('karambit_gold_runes','karambit_damascus_steel');
