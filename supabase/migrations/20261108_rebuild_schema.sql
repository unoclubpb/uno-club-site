-- Uno Club Site - Supabase rebuild schema
-- Created for archival/recovery purposes.
--
-- This file intentionally contains database STRUCTURE and harmless default rows only.
-- It does NOT contain real users, PIN hashes, session tokens, phone numbers, or other private data.
--
-- Recovery outline:
--   1. Create a new Supabase project.
--   2. Run this migration on the new project.
--   3. Deploy supabase/functions/uno-site-api from this repository.
--   4. Keep verify_jwt = false for uno-site-api as defined in supabase/config.toml.
--   5. Create the first administrator privately after deployment.
--   6. Update EDGE_FUNCTION_URL in app.js to the new Supabase project URL.
--
-- The Edge Function expects pgcrypto in the extensions schema.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.site_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  display_name text not null,
  pin_hash text not null,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists site_users_username_unique
  on public.site_users (lower(username));

create table if not exists public.site_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.site_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists site_sessions_user_id_idx
  on public.site_sessions(user_id);

create table if not exists public.site_rules (
  id integer primary key check (id = 1),
  body text not null,
  updated_at timestamptz not null default now()
);

insert into public.site_rules (id, body)
values (1, 'Uno Club rules will be added here.')
on conflict (id) do nothing;

create table if not exists public.game_schedule (
  id uuid primary key default gen_random_uuid(),
  day_name text not null,
  day_sort integer not null default 1,
  game_name text not null,
  start_time time,
  sort_order integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bonus_hands (
  id uuid primary key default gen_random_uuid(),
  hand_name text not null,
  payout_text text,
  description text,
  sort_order integer not null default 1,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.bonus_hands
  (hand_name, payout_text, description, sort_order, is_active)
select
  'Bonus Hand Information',
  'Coming Soon',
  'Qualifying hands, requirements and payout amounts will be listed here.',
  1,
  true
where not exists (
  select 1 from public.bonus_hands
);

create table if not exists public.site_settings (
  setting_key text primary key,
  setting_value text,
  updated_at timestamptz not null default now()
);

insert into public.site_settings (setting_key, setting_value)
values
  ('reservation_phone_1', ''),
  ('reservation_phone_2', '')
on conflict (setting_key) do nothing;

alter table public.site_users enable row level security;
alter table public.site_sessions enable row level security;
alter table public.site_rules enable row level security;
alter table public.game_schedule enable row level security;
alter table public.bonus_hands enable row level security;
alter table public.site_settings enable row level security;

-- No public REST access is granted to these tables.
-- The server-side Edge Function uses its database connection for all reads/writes.
revoke all on public.site_users from anon, authenticated;
revoke all on public.site_sessions from anon, authenticated;
revoke all on public.site_rules from anon, authenticated;
revoke all on public.game_schedule from anon, authenticated;
revoke all on public.bonus_hands from anon, authenticated;
revoke all on public.site_settings from anon, authenticated;

grant select, insert, update, delete
  on public.site_users,
     public.site_sessions,
     public.site_rules,
     public.game_schedule,
     public.bonus_hands,
     public.site_settings
  to service_role;
