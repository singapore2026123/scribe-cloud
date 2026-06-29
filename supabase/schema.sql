-- Scribe Cloud — Supabase schema. Run in Supabase Studio > SQL Editor.
-- Row-Level Security ensures each user only sees their own data.

-- ============ TABLES ============
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'Untitled session',
  src_lang    text,                       -- spoken language (ja/zh/ms/my/en/ta...)
  target_lang text,                       -- translation target
  notes       text,                       -- AI meeting notes (Markdown), generated on demand
  audio_path  text,                       -- path in the 'recordings' storage bucket (optional)
  created_at  timestamptz not null default now()
);

create table if not exists public.lines (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.sessions(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  idx         int  not null default 0,    -- order within the session
  speaker     int,                        -- speaker number for diarized records (nullable)
  raw         text,                        -- original transcription
  translation text,                        -- translated text
  created_at  timestamptz not null default now()
);

create index if not exists lines_session_idx on public.lines(session_id, idx);
create index if not exists sessions_user_idx on public.sessions(user_id, created_at desc);

-- ============ ROW-LEVEL SECURITY ============
alter table public.sessions enable row level security;
alter table public.lines    enable row level security;

create policy "own sessions" on public.sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own lines" on public.lines
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============ STORAGE (audio recordings) ============
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

create policy "own recordings read" on storage.objects
  for select using (bucket_id = 'recordings' and owner = auth.uid());
create policy "own recordings write" on storage.objects
  for insert with check (bucket_id = 'recordings' and owner = auth.uid());
create policy "own recordings delete" on storage.objects
  for delete using (bucket_id = 'recordings' and owner = auth.uid());
