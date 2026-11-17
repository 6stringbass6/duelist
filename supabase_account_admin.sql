-- 계정 조회(개발자 모드) 기간 정지 기능: profiles 에 정지 만료 시각/사유 컬럼 추가. 재실행 안전.
alter table public.profiles add column if not exists banned_until timestamptz;
alter table public.profiles add column if not exists ban_reason text;
create index if not exists profiles_banned_idx on public.profiles (banned_until) where banned_until is not null;
