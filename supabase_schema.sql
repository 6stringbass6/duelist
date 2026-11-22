-- =====================================================================
-- GRIDSTRIKE — Supabase schema (SQL Editor에 통째로 붙여넣어 실행)
-- 사전 설정: Auth > Providers > Email "Confirm email" OFF, Google provider ON
-- 원칙: 클라이언트는 읽기 + RPC만, 전적/크레딧/RP 쓰기는 서버(service_role)와 SECURITY DEFINER 함수만.
-- =====================================================================
create extension if not exists pgcrypto;

create or replace function public.kst_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Seoul')::date $$;

create or replace function public.ji(j jsonb, k text) returns int
language sql immutable as $$ select coalesce((j->>k)::numeric::int, 0) $$;

-- ---------------------------------------------------------------- tables
create table if not exists public.game_config (
  key text primary key,
  value jsonb not null
);

create table if not exists public.achievements (
  achievement_id text primary key,
  name text not null,
  description text not null,
  stat_key text not null,            -- kills | wins | matches | headshot_kills | assists | damage | peak_rp | login_streak | skins_owned
  threshold bigint not null,
  title text,                        -- 해금 칭호 (null = 칭호 없음)
  credit_reward int not null default 0,
  sort int not null default 0
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,              -- 간편가입 아이디 (Google 계정은 null)
  nickname text not null,
  credits int not null default 1000 check (credits >= 0),
  lootboxes int not null default 1 check (lootboxes >= 0),
  rank_points int not null default 0 check (rank_points >= 0),
  peak_rank_points int not null default 0,
  equipped_title text references public.achievements(achievement_id) on delete set null,
  login_streak int not null default 0,
  best_login_streak int not null default 0,
  last_login_date date,
  nickname_changes int not null default 0,
  settings jsonb not null default '{}'::jsonb,
  loadout jsonb not null default '{"melee":"dagger","secondary":"classic","primary":"vandal","throwable":"grenade"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_nickname_lower_idx on public.profiles (lower(nickname));
create index if not exists profiles_rank_idx on public.profiles (rank_points desc);

create table if not exists public.player_stats (
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('classic','ranked','tdm')),
  matches int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0,
  kills int not null default 0,
  deaths int not null default 0,
  assists int not null default 0,
  headshot_kills int not null default 0,
  hits_head int not null default 0,
  hits_body int not null default 0,
  hits_leg int not null default 0,
  shots_fired int not null default 0,
  damage_dealt bigint not null default 0,
  primary key (user_id, mode)
);

create table if not exists public.match_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null,
  map text not null,
  team_size int not null,
  result text not null check (result in ('win','loss','draw','left')),
  kills int not null default 0,
  deaths int not null default 0,
  assists int not null default 0,
  headshot_kills int not null default 0,
  damage int not null default 0,
  rp_delta int not null default 0,
  credits_earned int not null default 0,
  played_at timestamptz not null default now()
);
create index if not exists match_history_user_idx on public.match_history (user_id, played_at desc);

create table if not exists public.skin_catalog (
  skin_id text primary key,
  weapon_id text not null,
  name text not null,
  rarity text not null check (rarity in ('select','deluxe','premium','exclusive','ultra')),  -- 5단계 에디션 등급
  price int not null check (price >= 0),
  featured boolean not null default false,
  in_daily boolean not null default true,
  in_box boolean not null default true,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists public.user_skins (
  user_id uuid not null references public.profiles(id) on delete cascade,
  skin_id text not null references public.skin_catalog(skin_id) on delete cascade,
  weapon_id text not null,
  equipped boolean not null default false,
  source text not null default 'shop',     -- shop | featured | box | reward
  acquired_at timestamptz not null default now(),
  primary key (user_id, skin_id)
);
create unique index if not exists user_skins_one_equipped_idx on public.user_skins (user_id, weapon_id) where equipped;

create table if not exists public.lootboxes (
  box_id text primary key,
  name text not null,
  price int not null,
  active boolean not null default true
);
create table if not exists public.lootbox_rates (
  box_id text not null references public.lootboxes(box_id) on delete cascade,
  rarity text not null,
  weight numeric not null check (weight >= 0),
  dup_refund int not null default 0,
  primary key (box_id, rarity)
);

create table if not exists public.daily_shop (
  shop_date date not null,
  slot smallint not null,
  skin_id text not null references public.skin_catalog(skin_id) on delete cascade,
  price int not null,
  primary key (shop_date, slot)
);

create table if not exists public.user_achievements (
  user_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id text not null references public.achievements(achievement_id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

create table if not exists public.mission_pool (
  mission_id text primary key,
  description text not null,
  stat_key text not null,            -- 서버가 보내는 counters 키 (kills, headshot_kills, wins, matches, assists, damage, melee_kills, nade_kills, ranked_matches, tdm_kills ...)
  target int not null,
  reward_type text not null check (reward_type in ('credits','lootbox')),
  reward_amount int not null,
  active boolean not null default true
);
create table if not exists public.daily_missions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  mission_date date not null,
  slot smallint not null,
  mission_id text not null,
  description text not null,
  stat_key text not null,
  target int not null,
  progress int not null default 0,
  reward_type text not null,
  reward_amount int not null,
  claimed boolean not null default false,
  primary key (user_id, mission_date, slot)
);

create table if not exists public.login_rewards (
  day smallint primary key check (day between 1 and 7),
  reward_type text not null check (reward_type in ('credits','lootbox')),
  reward_amount int not null
);

-- ---------------------------------------------------------------- views
create or replace view public.public_profiles as
  select p.id, p.nickname, p.rank_points, p.peak_rank_points, p.equipped_title, a.title as title_text
  from public.profiles p left join public.achievements a on a.achievement_id = p.equipped_title;

create or replace view public.player_stats_total as
  select user_id,
    sum(matches)::int matches, sum(wins)::int wins, sum(losses)::int losses,
    sum(kills)::int kills, sum(deaths)::int deaths, sum(assists)::int assists,
    sum(headshot_kills)::int headshot_kills,
    round(sum(kills)::numeric / greatest(sum(deaths),1), 2) as kd,
    round(100.0 * sum(hits_head) / greatest(sum(hits_head+hits_body+hits_leg),1), 1) as hs_pct,
    round(100.0 * sum(wins) / greatest(sum(wins+losses),1), 1) as win_rate
  from public.player_stats group by user_id;

create or replace view public.leaderboard as
  select id, nickname, rank_points, rank() over (order by rank_points desc) as position
  from public.profiles where rank_points > 0 order by rank_points desc limit 200;

-- ---------------------------------------------------------------- RLS
alter table public.game_config enable row level security;
alter table public.achievements enable row level security;
alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.match_history enable row level security;
alter table public.skin_catalog enable row level security;
alter table public.user_skins enable row level security;
alter table public.lootboxes enable row level security;
alter table public.lootbox_rates enable row level security;
alter table public.daily_shop enable row level security;
alter table public.user_achievements enable row level security;
alter table public.mission_pool enable row level security;
alter table public.daily_missions enable row level security;
alter table public.login_rewards enable row level security;

do $$ declare t text; begin
  foreach t in array array['game_config','achievements','player_stats','skin_catalog','lootboxes','lootbox_rates','daily_shop','mission_pool','login_rewards'] loop
    execute format('drop policy if exists "read_all" on public.%I', t);
    execute format('create policy "read_all" on public.%I for select using (true)', t);
  end loop;
end $$;

drop policy if exists "own_select" on public.profiles;
create policy "own_select" on public.profiles for select using (auth.uid() = id);
drop policy if exists "own_update" on public.profiles;
create policy "own_update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
-- 클라이언트가 직접 고칠 수 있는 컬럼은 settings, loadout 뿐
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (settings, loadout) on public.profiles to authenticated;

drop policy if exists "own_select" on public.match_history;
create policy "own_select" on public.match_history for select using (auth.uid() = user_id);
drop policy if exists "own_select" on public.user_skins;
create policy "own_select" on public.user_skins for select using (auth.uid() = user_id);
drop policy if exists "own_select" on public.user_achievements;
create policy "own_select" on public.user_achievements for select using (auth.uid() = user_id);
drop policy if exists "own_select" on public.daily_missions;
create policy "own_select" on public.daily_missions for select using (auth.uid() = user_id);

grant select on public.public_profiles, public.player_stats_total, public.leaderboard to anon, authenticated;

-- ---------------------------------------------------------------- triggers
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- auth.users 한 행으로부터 profiles 행을 (없으면) 만든다. 트리거/백필/ensure_* 가 공유.
create or replace function public.create_profile_for(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare u auth.users; v_user text; v_base text; v_nick text; i int := 0;
begin
  select * into u from auth.users where id = p_id;
  if not found or exists (select 1 from profiles where id = p_id) then return; end if;
  if u.email like '%@game.local' then v_user := lower(split_part(u.email, '@', 1)); end if;
  v_base := regexp_replace(coalesce(u.raw_user_meta_data->>'nickname', u.raw_user_meta_data->>'full_name',
                                    u.raw_user_meta_data->>'name', v_user, 'Player'), '[^A-Za-z0-9가-힣_]', '', 'g');
  v_base := left(v_base, 12);
  if char_length(v_base) < 2 then v_base := 'Player'; end if;
  v_nick := v_base;
  while exists (select 1 from profiles where lower(nickname) = lower(v_nick)) loop
    i := i + 1;
    v_nick := v_base || floor(random() * 9000 + 1000)::int::text;
    exit when i > 30;
  end loop;
  insert into profiles (id, username, nickname) values (p_id, v_user, v_nick) on conflict do nothing;
end $$;
revoke execute on function public.create_profile_for(uuid) from public, anon, authenticated;
grant execute on function public.create_profile_for(uuid) to service_role;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.create_profile_for(new.id);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- 로그인 시 프로필이 없으면 자동 생성 (클라이언트용)
create or replace function public.ensure_my_profile() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then perform public.create_profile_for(auth.uid()); end if;
end $$;

-- 기존 누락 계정 일괄 백필 (재실행해도 안전)
do $$ declare r record; begin
  for r in select id from auth.users u where not exists (select 1 from public.profiles p where p.id = u.id) loop
    perform public.create_profile_for(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------- internal helpers
create or replace function public.check_achievements(p_user uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare v jsonb; r record; v_new text[] := '{}';
begin
  select jsonb_build_object('kills', coalesce(sum(kills),0), 'wins', coalesce(sum(wins),0), 'matches', coalesce(sum(matches),0),
         'headshot_kills', coalesce(sum(headshot_kills),0), 'assists', coalesce(sum(assists),0), 'damage', coalesce(sum(damage_dealt),0))
    into v from player_stats where user_id = p_user;
  select v || jsonb_build_object('peak_rp', peak_rank_points, 'login_streak', best_login_streak) into v from profiles where id = p_user;
  v := v || jsonb_build_object('skins_owned', (select count(*) from user_skins where user_id = p_user));
  for r in
    select a.* from achievements a
    where not exists (select 1 from user_achievements ua where ua.user_id = p_user and ua.achievement_id = a.achievement_id)
      and coalesce((v->>a.stat_key)::numeric, 0) >= a.threshold
  loop
    insert into user_achievements (user_id, achievement_id) values (p_user, r.achievement_id) on conflict do nothing;
    update profiles set credits = credits + r.credit_reward where id = p_user;
    v_new := v_new || r.achievement_id;
  end loop;
  return v_new;
end $$;

create or replace function public.ensure_daily_missions(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_today date := kst_today();
begin
  if exists (select 1 from daily_missions where user_id = p_user and mission_date = v_today) then return; end if;
  insert into daily_missions (user_id, mission_date, slot, mission_id, description, stat_key, target, reward_type, reward_amount)
  select p_user, v_today, row_number() over (), m.mission_id, m.description, m.stat_key, m.target, m.reward_type, m.reward_amount
  from (select * from mission_pool where active order by random() limit 3) m
  on conflict do nothing;
end $$;

-- ---------------------------------------------------------------- client RPC
create or replace function public.change_nickname(p_nickname text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_cost int; v_p profiles;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  p_nickname := btrim(p_nickname);
  if p_nickname !~ '^[A-Za-z0-9가-힣_]{2,16}$' then raise exception 'INVALID_NICKNAME'; end if;
  select coalesce((select (value)::text::int from game_config where key = 'nickname_change_cost'), 500) into v_cost;
  select * into v_p from profiles where id = v_uid for update;
  if lower(v_p.nickname) = lower(p_nickname) then raise exception 'SAME_NICKNAME'; end if;
  if exists (select 1 from profiles where lower(nickname) = lower(p_nickname) and id <> v_uid) then raise exception 'NICKNAME_TAKEN'; end if;
  if v_p.credits < v_cost then raise exception 'NOT_ENOUGH_CREDITS'; end if;
  update profiles set nickname = p_nickname, credits = credits - v_cost, nickname_changes = nickname_changes + 1 where id = v_uid returning * into v_p;
  return jsonb_build_object('nickname', v_p.nickname, 'credits', v_p.credits, 'cost', v_cost);
end $$;

create or replace function public.claim_daily_login() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_today date := kst_today(); v_p profiles; v_streak int; v_day int; v_r login_rewards; v_new text[];
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_p from profiles where id = v_uid for update;
  if v_p.last_login_date = v_today then
    return jsonb_build_object('claimed', false, 'streak', v_p.login_streak, 'day', ((v_p.login_streak - 1) % 7) + 1, 'credits', v_p.credits, 'lootboxes', v_p.lootboxes);
  end if;
  v_streak := case when v_p.last_login_date = v_today - 1 then v_p.login_streak + 1 else 1 end;
  v_day := ((v_streak - 1) % 7) + 1;
  select * into v_r from login_rewards where day = v_day;
  update profiles set login_streak = v_streak, best_login_streak = greatest(best_login_streak, v_streak), last_login_date = v_today,
    credits = credits + case when v_r.reward_type = 'credits' then v_r.reward_amount else 0 end,
    lootboxes = lootboxes + case when v_r.reward_type = 'lootbox' then v_r.reward_amount else 0 end
  where id = v_uid returning * into v_p;
  v_new := check_achievements(v_uid);
  return jsonb_build_object('claimed', true, 'streak', v_streak, 'day', v_day, 'reward_type', v_r.reward_type, 'reward_amount', v_r.reward_amount,
                            'credits', v_p.credits, 'lootboxes', v_p.lootboxes, 'unlocked', to_jsonb(v_new));
end $$;

create or replace function public.get_daily_shop()
returns table (slot smallint, skin_id text, price int, owned boolean)
language plpgsql security definer set search_path = public as $$
declare v_today date := kst_today();
begin
  perform pg_advisory_xact_lock(hashtext('daily_shop'));
  if not exists (select 1 from daily_shop d where d.shop_date = v_today) then
    insert into daily_shop (shop_date, slot, skin_id, price)
    select v_today, row_number() over (), s.skin_id, s.price
    from (select c.skin_id, c.price from skin_catalog c where c.active and c.in_daily and not c.featured order by random() limit 4) s;
  end if;
  return query
    select d.slot, d.skin_id, d.price,
           exists (select 1 from user_skins u where u.user_id = auth.uid() and u.skin_id = d.skin_id)
    from daily_shop d where d.shop_date = v_today order by d.slot;
end $$;

create or replace function public.buy_skin(p_skin_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_c skin_catalog; v_price int; v_src text; v_p profiles; v_new text[];
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_c from skin_catalog where skin_id = p_skin_id and active;
  if not found then raise exception 'SKIN_NOT_FOUND'; end if;
  select d.price into v_price from daily_shop d where d.shop_date = kst_today() and d.skin_id = p_skin_id;
  if v_price is not null then v_src := 'shop';
  elsif v_c.featured then v_price := v_c.price; v_src := 'featured';
  else raise exception 'NOT_FOR_SALE'; end if;
  select * into v_p from profiles where id = v_uid for update;
  if exists (select 1 from user_skins where user_id = v_uid and skin_id = p_skin_id) then raise exception 'ALREADY_OWNED'; end if;
  if v_p.credits < v_price then raise exception 'NOT_ENOUGH_CREDITS'; end if;
  update profiles set credits = credits - v_price where id = v_uid returning * into v_p;
  insert into user_skins (user_id, skin_id, weapon_id, source) values (v_uid, p_skin_id, v_c.weapon_id, v_src);
  v_new := check_achievements(v_uid);
  return jsonb_build_object('skin_id', p_skin_id, 'credits', (select credits from profiles where id = v_uid), 'unlocked', to_jsonb(v_new));
end $$;

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

create or replace function public.equip_skin(p_weapon_id text, p_skin_id text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_skin_id is not null and not exists (select 1 from user_skins where user_id = v_uid and skin_id = p_skin_id and weapon_id = p_weapon_id) then
    raise exception 'SKIN_NOT_OWNED';
  end if;
  update user_skins set equipped = false where user_id = v_uid and weapon_id = p_weapon_id and equipped;
  if p_skin_id is not null then update user_skins set equipped = true where user_id = v_uid and skin_id = p_skin_id; end if;
end $$;

create or replace function public.equip_title(p_achievement_id text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_achievement_id is not null and not exists (
    select 1 from user_achievements ua join achievements a using (achievement_id)
    where ua.user_id = v_uid and ua.achievement_id = p_achievement_id and a.title is not null) then
    raise exception 'TITLE_LOCKED';
  end if;
  update profiles set equipped_title = p_achievement_id where id = v_uid;
end $$;

create or replace function public.get_daily_missions() returns setof public.daily_missions
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform ensure_daily_missions(v_uid);
  return query select * from daily_missions where user_id = v_uid and mission_date = kst_today() order by slot;
end $$;

create or replace function public.claim_mission(p_slot int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_m daily_missions; v_p profiles;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_m from daily_missions where user_id = v_uid and mission_date = kst_today() and slot = p_slot for update;
  if not found then raise exception 'MISSION_NOT_FOUND'; end if;
  if v_m.claimed then raise exception 'ALREADY_CLAIMED'; end if;
  if v_m.progress < v_m.target then raise exception 'MISSION_INCOMPLETE'; end if;
  update daily_missions set claimed = true where user_id = v_uid and mission_date = v_m.mission_date and slot = p_slot;
  update profiles set
    credits = credits + case when v_m.reward_type = 'credits' then v_m.reward_amount else 0 end,
    lootboxes = lootboxes + case when v_m.reward_type = 'lootbox' then v_m.reward_amount else 0 end
  where id = v_uid returning * into v_p;
  return jsonb_build_object('reward_type', v_m.reward_type, 'reward_amount', v_m.reward_amount, 'credits', v_p.credits, 'lootboxes', v_p.lootboxes);
end $$;

create or replace function public.rank_position(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select (count(*) + 1)::int from profiles where rank_points > (select rank_points from profiles where id = p_user)
$$;

-- ---------------------------------------------------------------- server-only RPC (service_role)
create or replace function public.apply_match_result(p_user uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_mode text := p_result->>'mode'; v_res text := p_result->>'result';
        v_rp int := ji(p_result, 'rp_delta'); v_cr int := greatest(0, least(3000, ji(p_result, 'credits')));
        v_p profiles; v_new text[];
begin
  if v_mode not in ('classic','ranked','tdm') then raise exception 'BAD_MODE'; end if;
  if v_res not in ('win','loss','draw','left') then raise exception 'BAD_RESULT'; end if;
  if v_mode <> 'ranked' then v_rp := 0; end if;

  insert into player_stats as s (user_id, mode, matches, wins, losses, draws, kills, deaths, assists, headshot_kills,
                                 hits_head, hits_body, hits_leg, shots_fired, damage_dealt)
  values (p_user, v_mode, 1, (v_res = 'win')::int, (v_res in ('loss','left'))::int, (v_res = 'draw')::int,
          ji(p_result,'kills'), ji(p_result,'deaths'), ji(p_result,'assists'), ji(p_result,'headshot_kills'),
          ji(p_result,'hits_head'), ji(p_result,'hits_body'), ji(p_result,'hits_leg'), ji(p_result,'shots_fired'), ji(p_result,'damage'))
  on conflict (user_id, mode) do update set
    matches = s.matches + 1, wins = s.wins + excluded.wins, losses = s.losses + excluded.losses, draws = s.draws + excluded.draws,
    kills = s.kills + excluded.kills, deaths = s.deaths + excluded.deaths, assists = s.assists + excluded.assists,
    headshot_kills = s.headshot_kills + excluded.headshot_kills, hits_head = s.hits_head + excluded.hits_head,
    hits_body = s.hits_body + excluded.hits_body, hits_leg = s.hits_leg + excluded.hits_leg,
    shots_fired = s.shots_fired + excluded.shots_fired, damage_dealt = s.damage_dealt + excluded.damage_dealt;

  update profiles set credits = credits + v_cr,
                      rank_points = greatest(0, rank_points + v_rp),
                      peak_rank_points = greatest(peak_rank_points, rank_points + v_rp)
  where id = p_user returning * into v_p;
  if not found then raise exception 'NO_PROFILE'; end if;

  insert into match_history (user_id, mode, map, team_size, result, kills, deaths, assists, headshot_kills, damage, rp_delta, credits_earned)
  values (p_user, v_mode, coalesce(p_result->>'map','?'), ji(p_result,'team_size'), v_res, ji(p_result,'kills'), ji(p_result,'deaths'),
          ji(p_result,'assists'), ji(p_result,'headshot_kills'), ji(p_result,'damage'), v_rp, v_cr);

  perform ensure_daily_missions(p_user);
  update daily_missions m set progress = least(m.target, m.progress + ji(coalesce(p_result->'counters','{}'::jsonb), m.stat_key))
  where m.user_id = p_user and m.mission_date = kst_today() and not m.claimed;

  v_new := check_achievements(p_user);
  select * into v_p from profiles where id = p_user;
  return jsonb_build_object('credits', v_p.credits, 'rank_points', v_p.rank_points, 'rp_delta', v_rp, 'credits_earned', v_cr, 'unlocked', to_jsonb(v_new));
end $$;

-- ---------------------------------------------------------------- function privileges
revoke execute on all functions in schema public from public, anon;
grant execute on function public.kst_today(), public.ji(jsonb, text) to anon, authenticated, service_role;
grant execute on function public.change_nickname(text), public.claim_daily_login(), public.get_daily_shop(), public.buy_skin(text),
  public.open_lootbox(text, boolean), public.equip_skin(text, text), public.equip_title(text), public.get_daily_missions(),
  public.claim_mission(int), public.rank_position(uuid), public.ensure_my_profile() to authenticated;
grant execute on function public.create_profile_for(uuid) to service_role;
revoke execute on function public.apply_match_result(uuid, jsonb), public.check_achievements(uuid), public.ensure_daily_missions(uuid) from authenticated;
grant execute on function public.apply_match_result(uuid, jsonb), public.check_achievements(uuid), public.ensure_daily_missions(uuid),
  public.rank_position(uuid) to service_role;

-- ---------------------------------------------------------------- seed
insert into public.game_config (key, value) values ('nickname_change_cost', '500') on conflict (key) do nothing;

insert into public.login_rewards (day, reward_type, reward_amount) values
  (1,'credits',100),(2,'credits',150),(3,'credits',200),(4,'credits',250),(5,'credits',300),(6,'credits',400),(7,'lootbox',1)
on conflict (day) do update set reward_type = excluded.reward_type, reward_amount = excluded.reward_amount;

insert into public.lootboxes (box_id, name, price) values ('standard','스탠다드 박스',1000), ('premium','프리미엄 박스',2000), ('karambit','카람빗 스페셜 박스',4000)
on conflict (box_id) do update set name = excluded.name, price = excluded.price;

-- ── 5단계 등급 마이그레이션 (1/2): 구버전 등급값(common/rare/epic/legendary/mythic) → select/deluxe/premium/exclusive/ultra. 여러 번 실행해도 안전
alter table public.skin_catalog drop constraint if exists skin_catalog_rarity_check;
update public.skin_catalog set rarity = case rarity when 'common' then 'select' when 'rare' then 'deluxe' when 'epic' then 'premium'
  when 'legendary' then 'exclusive' when 'mythic' then 'ultra' else rarity end
where rarity in ('common','rare','epic','legendary','mythic');
alter table public.skin_catalog add constraint skin_catalog_rarity_check check (rarity in ('select','deluxe','premium','exclusive','ultra'));
delete from public.lootbox_rates where rarity not in ('select','deluxe','premium','exclusive','ultra','karambit');

-- 중복 환급 = 등급 가격의 25%
insert into public.lootbox_rates (box_id, rarity, weight, dup_refund) values
  ('standard','select',55,150),('standard','deluxe',28,300),('standard','premium',12,550),('standard','exclusive',4.2,800),('standard','ultra',0.8,1125),
  ('premium','select',20,150),('premium','deluxe',40,300),('premium','premium',27,550),('premium','exclusive',10,800),('premium','ultra',3,1125),
  -- 카람빗 스페셜 박스: 0.1% 카람빗(단검, 중복 환급 2000) / 4.9% 울트라 / 15% 익스클루시브 / 35% 프리미엄 / 45% 디럭스 (총기 스킨, 셀렉트 제외)
  ('karambit','karambit',0.1,2000),('karambit','ultra',4.9,1125),('karambit','exclusive',15,800),('karambit','premium',35,550),('karambit','deluxe',45,300),('karambit','select',0,150)
on conflict (box_id, rarity) do update set weight = excluded.weight, dup_refund = excluded.dup_refund;

-- 스킨 카탈로그: id = <collection>_<weapon>. (client/src/config/skins.ts 와 동일 규칙)
-- 가격: 5판 기준 매치 보상(승리 1000 / 패배 500)에 비례 — 셀렉트 600 / 디럭스 1200 / 프리미엄 2200 / 익스클루시브 3200 / 울트라 4500
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort)
select c.id || '_' || w.id, w.id, c.name || ' ' || w.name, c.rarity, c.price, c.featured, not c.featured, not c.featured, c.sort
from (values
  ('matte','택티컬 매트','select',600,false,1), ('digicamo','디지털 카모','select',600,false,2), ('steel','브러시드 스틸','select',600,false,3),
  ('anodized','아노다이즈','deluxe',1200,false,4), ('hexarmor','헥사 아머','deluxe',1200,false,5), ('racing','투톤 레이싱','deluxe',1200,false,6),
  ('circuit','네온 서킷','premium',2200,false,7), ('glitch','글리치 버스트','premium',2200,false,8), ('gloss','캔디 크롬','premium',2200,false,9),
  ('flux','플럭스','exclusive',3200,false,10), ('aurora','오로라','exclusive',3200,false,11),
  ('solar','솔라 프라임','ultra',4500,true,12), ('abyss','어비스 코어','ultra',4500,false,13)
) as c(id, name, rarity, price, featured, sort)
cross join (values
  ('dagger','단검'),('sword','장검'),('classic','클래식'),('shorty','쇼티'),('frenzy','프렌지'),('ghost','고스트'),
  ('sheriff','디글'),('vandal','AK-47'),('phantom','팬텀'),('marshal','마샬'),('odin','오딘')
) as w(id, name)
on conflict (skin_id) do update set name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = excluded.featured, in_daily = excluded.in_daily, in_box = excluded.in_box, sort = excluded.sort, active = true;

-- 카람빗: 단검 전용 · 카람빗 스페셜 박스 0.1% 한정 (in_box=false 라 다른 박스/일일 상점에는 나오지 않고 구매 불가)
insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort)
values ('karambit_dagger','dagger','카람빗','ultra',4500,false,false,false,14)
on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,
  featured = false, in_daily = false, in_box = false, sort = excluded.sort, active = true;

-- ── 5단계 등급 마이그레이션 (2/2): 구버전 컬렉션 보유분을 같은 등급대의 신규 컬렉션으로 이관 (클라이언트 LEGACY_COLLECTIONS 와 동일 매핑)
with m(old_id, new_id) as (values
  ('carbon','matte'),('tundra','digicamo'),('neon','hexarmor'),('sakura','anodized'),('magma','glitch'),
  ('glacier','gloss'),('void','aurora'),('aurum','flux'),('singularity','abyss'))
update public.user_skins u set skin_id = m.new_id || substr(u.skin_id, length(m.old_id) + 1)
from m
where split_part(u.skin_id, '_', 1) = m.old_id
  and exists (select 1 from public.skin_catalog c where c.skin_id = m.new_id || substr(u.skin_id, length(m.old_id) + 1))
  and not exists (select 1 from public.user_skins x where x.user_id = u.user_id and x.skin_id = m.new_id || substr(u.skin_id, length(m.old_id) + 1));
delete from public.daily_shop where split_part(skin_id, '_', 1) in ('carbon','tundra','neon','sakura','magma','glacier','void','aurum','singularity'); -- 오늘자 상점은 다음 조회 때 새 카탈로그로 재생성
update public.skin_catalog set active = false, in_daily = false, in_box = false, featured = false
where split_part(skin_id, '_', 1) in ('carbon','tundra','neon','sakura','magma','glacier','void','aurum','singularity');

insert into public.achievements (achievement_id, name, description, stat_key, threshold, title, credit_reward, sort) values
  ('first_blood','첫 처치','첫 킬을 달성','kills',1,'신입',100,1),
  ('kills_100','백전노장','누적 100킬','kills',100,'사냥꾼',300,2),
  ('kills_1000','학살자','누적 1,000킬','kills',1000,'학살자',1000,3),
  ('hs_50','명사수','헤드샷 킬 50회','headshot_kills',50,'원탭 장인',400,4),
  ('hs_500','헤드헌터','헤드샷 킬 500회','headshot_kills',500,'헤드헌터',1200,5),
  ('wins_10','승리의 맛','10승 달성','wins',10,'승부사',300,6),
  ('wins_100','백승장군','100승 달성','wins',100,'백승장군',1500,7),
  ('matches_50','단골','50판 플레이','matches',50,'단골손님',300,8),
  ('assist_100','조력자','어시스트 100회','assists',100,'서포터',300,9),
  ('rp_gold','골드 진입','골드 티어 도달','peak_rp',1200,'골드',500,10),
  ('rp_diamond','다이아 진입','다이아몬드 티어 도달','peak_rp',2400,'다이아몬드',1000,11),
  ('rp_nemesis','네메시스','네메시스 티어 도달','peak_rp',3600,'네메시스',3000,12),
  ('streak_7','개근상','7일 연속 로그인','login_streak',7,'개근왕',500,13),
  ('collector_10','수집가','스킨 10종 보유','skins_owned',10,'컬렉터',500,14)
on conflict (achievement_id) do update set name = excluded.name, description = excluded.description, stat_key = excluded.stat_key,
  threshold = excluded.threshold, title = excluded.title, credit_reward = excluded.credit_reward, sort = excluded.sort;

insert into public.mission_pool (mission_id, description, stat_key, target, reward_type, reward_amount) values
  ('m_kills_15','적 15명 처치','kills',15,'credits',150),
  ('m_kills_30','적 30명 처치','kills',30,'credits',300),
  ('m_hs_8','헤드샷 킬 8회','headshot_kills',8,'credits',250),
  ('m_wins_2','2승 달성','wins',2,'credits',250),
  ('m_matches_3','3판 플레이','matches',3,'credits',150),
  ('m_assists_6','어시스트 6회','assists',6,'credits',150),
  ('m_damage_3000','누적 피해 3,000','damage',3000,'credits',200),
  ('m_melee_2','근접무기로 2킬','melee_kills',2,'lootbox',1),
  ('m_nade_2','수류탄으로 2킬','nade_kills',2,'credits',300),
  ('m_ranked_2','경쟁전 2판 플레이','ranked_matches',2,'lootbox',1),
  ('m_tdm_20','팀 데스매치에서 20킬','tdm_kills',20,'credits',250)
on conflict (mission_id) do update set description = excluded.description, stat_key = excluded.stat_key, target = excluded.target,
  reward_type = excluded.reward_type, reward_amount = excluded.reward_amount;

-- ---------------------------------------------------------------- 고객센터 / 개발자 모드
-- 서버(service_role)만 접근. 클라이언트 직접 접근(anon/authenticated) 차단.
create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null,
  message text not null check (char_length(message) between 1 and 500),
  status text not null default 'open' check (status in ('open','done')),
  created_at timestamptz not null default now()
);
create index if not exists support_tickets_created_idx on public.support_tickets (created_at desc);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at);
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;

-- 크레딧 증감 (원자적, 0 미만/20억 초과는 클램프). service_role 전용.
create or replace function public.admin_adjust_credits(p_user uuid, p_delta int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_before int; v_after int;
begin
  select credits into v_before from profiles where id = p_user for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  v_after := least(greatest(v_before::bigint + p_delta, 0), 2000000000);
  update profiles set credits = v_after where id = p_user;
  return jsonb_build_object('before', v_before, 'after', v_after);
end $$;
revoke all on function public.admin_adjust_credits(uuid, int) from public, anon, authenticated;
grant execute on function public.admin_adjust_credits(uuid, int) to service_role;
