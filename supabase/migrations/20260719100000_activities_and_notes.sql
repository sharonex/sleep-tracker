alter table public.sleep_events drop constraint sleep_events_event_type_check;
alter table public.sleep_events add constraint sleep_events_event_type_check
  check (event_type in ('woke_slept', 'breastfed', 'fell_asleep', 'woke_up', 'solid_food'));

alter table public.sleep_events add column note text;

-- One free-form note per night (keyed by the Israel calendar date the night starts on)
create table public.night_notes (
  night_date date primary key,
  note text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.night_notes enable row level security;
