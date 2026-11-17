-- =====================================================================
-- DUELIST 친구 시스템 (supabase_schema.sql 적용 후 SQL Editor 에서 1회 실행 · 재실행 안전)
-- 친구 관계만 DB 에 저장. 접속 상태(presence)·파티 초대(broadcast)는 Supabase Realtime 채널을 쓴다.
-- =====================================================================
create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester <> addressee)
);
-- 같은 두 사람 사이에는 방향과 무관하게 관계 1개만
create unique index if not exists friendships_pair_idx on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee_idx on public.friendships (addressee);

alter table public.friendships enable row level security;
drop policy if exists "own_select" on public.friendships;
create policy "own_select" on public.friendships for select using (auth.uid() in (requester, addressee));
revoke insert, update, delete on public.friendships from anon, authenticated;

-- 내 친구/요청 목록 (상대 닉네임·랭크 포함)
create or replace function public.list_friends()
returns table (id bigint, friend_id uuid, nickname text, rank_points int, status text, outgoing boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select f.id, p.id, p.nickname, p.rank_points, f.status, f.requester = auth.uid(), f.created_at
  from friendships f
  join profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
  where auth.uid() is not null and auth.uid() in (f.requester, f.addressee)
  order by f.status, lower(p.nickname);
$$;

-- 닉네임으로 친구 요청. 상대가 이미 나에게 요청을 보낸 상태면 즉시 수락.
create or replace function public.send_friend_request(p_nickname text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_to uuid; v_f friendships;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select id into v_to from profiles where lower(nickname) = lower(trim(p_nickname));
  if v_to is null then raise exception 'FRIEND_NOT_FOUND'; end if;
  if v_to = v_uid then raise exception 'FRIEND_SELF'; end if;
  select * into v_f from friendships where least(requester, addressee) = least(v_uid, v_to) and greatest(requester, addressee) = greatest(v_uid, v_to) for update;
  if found then
    if v_f.status = 'pending' and v_f.addressee = v_uid then
      update friendships set status = 'accepted', responded_at = now() where id = v_f.id;
      return jsonb_build_object('status', 'accepted', 'id', v_f.id);
    end if;
    raise exception 'FRIEND_EXISTS';
  end if;
  if (select count(*) from friendships where v_uid in (requester, addressee)) >= 100 then raise exception 'FRIEND_LIMIT'; end if;
  insert into friendships (requester, addressee) values (v_uid, v_to) returning * into v_f;
  return jsonb_build_object('status', 'pending', 'id', v_f.id);
end $$;

-- 받은 요청 수락/거절 (거절 = 삭제)
create or replace function public.respond_friend_request(p_id bigint, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_accept then
    update friendships set status = 'accepted', responded_at = now() where id = p_id and addressee = v_uid and status = 'pending';
  else
    delete from friendships where id = p_id and addressee = v_uid and status = 'pending';
  end if;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
end $$;

-- 친구 삭제 / 보낸 요청 취소
create or replace function public.remove_friend(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  delete from friendships where id = p_id and v_uid in (requester, addressee);
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
end $$;

revoke execute on function public.list_friends(), public.send_friend_request(text), public.respond_friend_request(bigint, boolean), public.remove_friend(bigint) from public, anon;
grant execute on function public.list_friends(), public.send_friend_request(text), public.respond_friend_request(bigint, boolean), public.remove_friend(bigint) to authenticated;
