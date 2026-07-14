alter table public.sleep_events drop constraint sleep_events_event_type_check;
alter table public.sleep_events add constraint sleep_events_event_type_check
  check (event_type in ('woke_slept', 'breastfed', 'fell_asleep'));
