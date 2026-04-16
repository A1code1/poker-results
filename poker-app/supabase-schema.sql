-- Run this in your Supabase SQL editor to create the games table
-- Dashboard → SQL Editor → New query → paste this → Run

create table if not exists games (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  game_date date,
  date_source text,
  summary jsonb not null,
  results jsonb not null,
  settlements jsonb not null,
  players jsonb not null,
  host_id text
);

-- Add scoresheet_url column (run if table already exists)
alter table games add column if not exists scoresheet_url text;

-- Index for fast date ordering
create index if not exists games_game_date_idx on games (game_date desc);

-- Enable Row Level Security but allow all access (passcode is enforced at app level)
alter table games enable row level security;

create policy "Allow all" on games
  for all
  using (true)
  with check (true);
