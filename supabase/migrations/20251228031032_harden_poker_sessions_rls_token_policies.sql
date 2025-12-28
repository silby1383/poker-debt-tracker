BEGIN;

-- Ensure RLS is on
alter table public.poker_sessions enable row level security;

-- Ensure tokens are unique
create unique index if not exists poker_sessions_access_token_key
  on public.poker_sessions (access_token);

-- Remove any legacy wide-open policy names (if they exist)
drop policy if exists "Public read/write poker sessions" on public.poker_sessions;

-- Recreate policies idempotently

drop policy if exists "Insert poker sessions" on public.poker_sessions;
create policy "Insert poker sessions"
  on public.poker_sessions
  for insert
  with check (true);

drop policy if exists "Select poker sessions with token" on public.poker_sessions;
create policy "Select poker sessions with token"
  on public.poker_sessions
  for select
  using (
    access_token = coalesce(
      (current_setting('request.headers', true)::json ->> 'x-session-token'),
      ''
    )
  );

drop policy if exists "Update poker sessions with token" on public.poker_sessions;
create policy "Update poker sessions with token"
  on public.poker_sessions
  for update
  using (
    access_token = coalesce(
      (current_setting('request.headers', true)::json ->> 'x-session-token'),
      ''
    )
  )
  with check (
    access_token = coalesce(
      (current_setting('request.headers', true)::json ->> 'x-session-token'),
      ''
    )
  );

drop policy if exists "Delete poker sessions with token" on public.poker_sessions;
create policy "Delete poker sessions with token"
  on public.poker_sessions
  for delete
  using (
    access_token = coalesce(
      (current_setting('request.headers', true)::json ->> 'x-session-token'),
      ''
    )
  );

COMMIT;