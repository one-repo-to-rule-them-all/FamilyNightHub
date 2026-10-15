-- Family Night Hub: initial schema

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.family_members (
  family_id uuid not null references public.families on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);

create table public.family_nights (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  title text not null,
  notes text,
  scheduled_for timestamptz not null,
  created_by uuid not null default auth.uid() references auth.users,
  created_at timestamptz not null default now()
);

create table public.night_ideas (
  id uuid primary key default gen_random_uuid(),
  family_night_id uuid not null references public.family_nights on delete cascade,
  suggestion text not null,
  suggested_by uuid not null default auth.uid() references auth.users,
  created_at timestamptz not null default now()
);

create table public.idea_votes (
  idea_id uuid not null references public.night_ideas on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  primary key (idea_id, user_id)
);

create index on public.family_members (user_id);
create index on public.family_nights (family_id, scheduled_for);
create index on public.night_ideas (family_night_id);

-- Membership helper (security definer avoids RLS recursion on family_members)
create function public.is_family_member(fid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.family_members
    where family_id = fid and user_id = (select auth.uid())
  );
$$;

-- Creator becomes owner automatically
create function public.add_family_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.family_members (family_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger on_family_created
  after insert on public.families
  for each row execute function public.add_family_owner();

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_nights enable row level security;
alter table public.night_ideas enable row level security;
alter table public.idea_votes enable row level security;

create policy "members read family" on public.families
  for select to authenticated
  using (public.is_family_member(id) or created_by = (select auth.uid()));
create policy "users create family" on public.families
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "members read membership" on public.family_members
  for select to authenticated using (public.is_family_member(family_id));
create policy "leave family" on public.family_members
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "members read nights" on public.family_nights
  for select to authenticated using (public.is_family_member(family_id));
create policy "members create nights" on public.family_nights
  for insert to authenticated
  with check (public.is_family_member(family_id) and created_by = (select auth.uid()));
create policy "creator edits nights" on public.family_nights
  for update to authenticated using (created_by = (select auth.uid()));
create policy "creator deletes nights" on public.family_nights
  for delete to authenticated using (created_by = (select auth.uid()));

create policy "members read ideas" on public.night_ideas
  for select to authenticated using (
    exists (select 1 from public.family_nights n
            where n.id = family_night_id and public.is_family_member(n.family_id)));
create policy "members add ideas" on public.night_ideas
  for insert to authenticated with check (
    suggested_by = (select auth.uid()) and
    exists (select 1 from public.family_nights n
            where n.id = family_night_id and public.is_family_member(n.family_id)));

create policy "members read votes" on public.idea_votes
  for select to authenticated using (
    exists (select 1 from public.night_ideas i
            join public.family_nights n on n.id = i.family_night_id
            where i.id = idea_id and public.is_family_member(n.family_id)));
create policy "members vote" on public.idea_votes
  for insert to authenticated with check (
    user_id = (select auth.uid()) and
    exists (select 1 from public.night_ideas i
            join public.family_nights n on n.id = i.family_night_id
            where i.id = idea_id and public.is_family_member(n.family_id)));
create policy "remove own vote" on public.idea_votes
  for delete to authenticated using (user_id = (select auth.uid()));
