-- Travel Compass activity data and administrator-only moderation.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id text primary key,
  source_id text,
  source_hash text,
  status text not null check (status in ('Pending', 'Approved', 'Rejected')),
  title text not null,
  city text not null,
  district text,
  start_date date not null,
  end_date date not null,
  kid_friendly boolean not null default false,
  category text,
  summary text,
  lat double precision,
  lng double precision,
  source_url text,
  source_name text,
  source_refs jsonb not null default '[]'::jsonb,
  location_precision text,
  moderated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint events_date_order check (end_date >= start_date)
);

create index if not exists events_public_listing_idx on public.events (status, end_date, start_date);
create index if not exists events_city_listing_idx on public.events (city, status, end_date);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    execute 'alter publication supabase_realtime add table public.events';
  end if;
end;
$$;

alter table public.admin_users enable row level security;
alter table public.events enable row level security;

revoke all on public.admin_users from anon, authenticated;
grant select on public.admin_users to authenticated;
drop policy if exists "Admins can read their own membership" on public.admin_users;
create policy "Admins can read their own membership" on public.admin_users
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.is_event_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_event_admin() from public;
grant execute on function public.is_event_admin() to anon, authenticated;

revoke all on public.events from anon, authenticated;
grant select on public.events to anon, authenticated;
grant update (status, moderated_at) on public.events to authenticated;
grant all on public.events to service_role;

drop policy if exists "Public can read approved current events" on public.events;
create policy "Public can read approved current events" on public.events
  for select to anon, authenticated
  using (status = 'Approved' and end_date >= (now() at time zone 'Asia/Taipei')::date);

drop policy if exists "Admins can read all events" on public.events;
create policy "Admins can read all events" on public.events
  for select to authenticated using (public.is_event_admin());

drop policy if exists "Admins can moderate events" on public.events;
create policy "Admins can moderate events" on public.events
  for update to authenticated
  using (public.is_event_admin())
  with check (public.is_event_admin());
