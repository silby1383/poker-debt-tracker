BEGIN;

create extension if not exists pgcrypto;

create table if not exists public.poker_sessions (
  id uuid primary key default gen_random_uuid(),
  name text,
  currency text not null default 'USD',
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists poker_sessions_set_updated_at on public.poker_sessions;
create trigger poker_sessions_set_updated_at
before update on public.poker_sessions
for each row
execute function public.set_updated_at();

alter table public.poker_sessions enable row level security;

drop policy if exists "Public read/write poker sessions" on public.poker_sessions;
create policy "Public read/write poker sessions"
  on public.poker_sessions
  for all
  using (true)
  with check (true);

COMMIT;