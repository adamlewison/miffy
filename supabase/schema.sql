-- Run once in the Supabase SQL editor.
-- One table: the bunny's long-term memories (extracted facts only, never audio).
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  fact text not null check (char_length(fact) between 3 and 400),
  created_at timestamptz not null default now()
);

create index if not exists memories_created_at_idx on public.memories (created_at desc);

-- Lock the table down: only the server (service role key) can read/write.
alter table public.memories enable row level security;
-- (No policies = anon/authenticated roles get nothing. The service role bypasses RLS.)
