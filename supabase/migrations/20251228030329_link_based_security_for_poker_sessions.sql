BEGIN;

alter table public.poker_sessions
  add column if not exists access_token text;

update public.poker_sessions
set access_token = encode(gen_random_bytes(16), 'hex')
where access_token is null;

alter table public.poker_sessions
  alter column access_token set default encode(gen_random_bytes(16), 'hex'),
  alter column access_token set not null;

-- Replace the wide-open policy with link-token based policies.
drop policy if exists "Public read/write poker sessions" on public.poker_sessions;

-- Allow anyone to create a new session (they'll receive the token in the insert response)
create policy "Insert poker sessions" 
  on public.poker_sessions
  for insert
  with check (true);

-- Token must match for read/update/delete
create policy "Select poker sessions with token"
  on public.poker_sessions
  for select
  using (
    access_token = coalesce(
      (current_setting('request.headers', true)::json ->> 'x-session-token'),
      ''
    )
  );

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