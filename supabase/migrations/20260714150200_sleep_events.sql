create table public.sleep_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('woke_slept', 'breastfed')),
  created_at timestamptz not null default now()
);

-- No policies on purpose: only the edge function (service role) touches this table
alter table public.sleep_events enable row level security;

create index sleep_events_created_at_idx on public.sleep_events (created_at desc);
