-- Hand Histories (prototype partagé anon). Exécuter dans le SQL Editor Supabase.

create extension if not exists "pgcrypto";

create table if not exists public.hands (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  created_at timestamptz not null default now(),
  player_count int not null check (player_count >= 2 and player_count <= 10),
  first_to_act int not null check (first_to_act >= 0 and first_to_act < player_count),
  small_blind_bb numeric not null check (small_blind_bb > 0 and small_blind_bb <= big_blind_bb),
  big_blind_bb numeric not null check (big_blind_bb > 0),
  dead_money_bb numeric not null default 0 check (dead_money_bb >= 0),
  tags text[] not null default '{}',
  stacks_bb jsonb not null,
  -- Mises obligatoires par siège avant distribution (SB, BB, straddles…), pas les antes.
  antes_bb jsonb not null default '[]'::jsonb,
  hole_cards jsonb not null default '{}'::jsonb,
  timeline jsonb not null default '[]'::jsonb
);

create index if not exists hands_created_at_idx on public.hands (created_at desc);
create index if not exists hands_tags_gin on public.hands using gin (tags);

alter table public.hands enable row level security;

-- Prototype : accès complet pour le rôle anon (à restreindre en production).
drop policy if exists "hands_anon_all" on public.hands;
create policy "hands_anon_all"
  on public.hands
  for all
  to anon
  using (true)
  with check (true);

grant usage on schema public to anon;
grant all on table public.hands to anon;
