begin;

-- =========================================================
-- Recurring trash reminders
--
-- Behaviour:
--   1. A change to needs_taking creates the immediate notification.
--   2. The first reminder is scheduled for approximately 8 hours later.
--   3. Further reminders continue every ~8 hours while the trash remains
--      in needs_taking.
--   4. Marking the trash as taken clears the reminder schedule.
--
-- Supabase Cron (pg_cron) should be enabled before this migration if you
-- want the migration to create the checker job automatically. If Cron is
-- enabled later, use the scheduling SQL documented in SETUP.md.
-- =========================================================

-- Track when a trash item entered Needs taking and when its next reminder
-- should be created.
alter table public.trash_types
  add column if not exists next_reminder_at timestamptz;

alter table public.trash_types
  add column if not exists needs_taking_since timestamptz;

-- Existing rows already in Needs taking get sensible initial values.
update public.trash_types
set needs_taking_since = coalesce(
  needs_taking_since,
  updated_at,
  now()
)
where status = 'needs_taking';

update public.trash_types
set next_reminder_at = now() + interval '8 hours'
where status = 'needs_taking'
  and next_reminder_at is null;

-- Non-pending rows must never retain reminder state.
update public.trash_types
set
  needs_taking_since = null,
  next_reminder_at = null
where status <> 'needs_taking';

-- Keep the notification type constraint aligned with every notification
-- type used by the current application functions.
alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (
    type in (
      'trash_needs_taking',
      'trash_reminder',
      'trash_reassigned',
      'availability',
      'system'
    )
  );

-- =========================================================
-- Status changes: immediate alert + schedule first reminder
-- =========================================================

create or replace function public.set_trash_status(
  p_trash_id text,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor uuid := auth.uid();
  v_old text;
  v_trash_name text;
  v_actor_name text;
  v_assignee uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  if p_status not in ('ok', 'getting_full', 'needs_taking') then
    raise exception 'Invalid status';
  end if;

  select status, name, next_person
  into v_old, v_trash_name, v_assignee
  from public.trash_types
  where id = p_trash_id
  for update;

  if not found then
    raise exception 'Unknown trash type';
  end if;

  if v_old = p_status then
    return;
  end if;

  select display_name
  into v_actor_name
  from public.profiles
  where id = v_actor;

  -- If the assigned person is away, select the next available person.
  if p_status = 'needs_taking'
     and (
       v_assignee is null
       or not public.person_is_available(v_assignee)
     ) then
    v_assignee := public.next_available_after(
      coalesce(v_assignee, v_actor)
    );
  end if;

  update public.trash_types
  set
    status = p_status,
    next_person = case
      when p_status = 'needs_taking' and v_assignee is not null
        then v_assignee
      else next_person
    end,
    needs_taking_since = case
      when p_status = 'needs_taking' then now()
      else null
    end,
    next_reminder_at = case
      when p_status = 'needs_taking' then now() + interval '8 hours'
      else null
    end,
    updated_at = now()
  where id = p_trash_id;

  insert into public.activity_log (
    type,
    actor_id,
    trash_id,
    from_status,
    to_status,
    summary
  )
  values (
    'status',
    v_actor,
    p_trash_id,
    v_old,
    p_status,
    v_actor_name || ' changed ' || v_trash_name || ' from ' ||
      case v_old
        when 'ok' then 'OK'
        when 'getting_full' then 'Getting full'
        when 'needs_taking' then 'Needs taking'
      end ||
      ' to ' ||
      case p_status
        when 'ok' then 'OK'
        when 'getting_full' then 'Getting full'
        when 'needs_taking' then 'Needs taking'
      end
  );

  if p_status = 'needs_taking' and v_assignee is not null then
    insert into public.notifications (
      recipient_id,
      type,
      title,
      body,
      trash_id,
      actor_id,
      url
    )
    values (
      v_assignee,
      'trash_needs_taking',
      '🗑️ ' || v_trash_name || ' needs taking',
      'It is your turn to take out ' || v_trash_name || '.',
      p_trash_id,
      v_actor,
      '/#home'
    );
  end if;
end;
$function$;

-- =========================================================
-- Taking out trash: cancel all future reminders for that item
-- =========================================================

create or replace function public.take_out_trash(p_trash_id text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_actor uuid := auth.uid();
  v_expected uuid;
  v_next uuid;
  v_trash_name text;
  v_actor_name text;
  v_expected_name text;
  v_voluntary boolean;
begin
  if v_actor is null then
    raise exception 'Not authenticated';
  end if;

  select next_person, name
  into v_expected, v_trash_name
  from public.trash_types
  where id = p_trash_id
  for update;

  if not found then
    raise exception 'Unknown trash type';
  end if;

  select display_name
  into v_actor_name
  from public.profiles
  where id = v_actor;

  select display_name
  into v_expected_name
  from public.profiles
  where id = v_expected;

  v_voluntary := (v_expected is distinct from v_actor);
  v_next := public.next_available_after(v_actor);

  update public.trash_types
  set
    status = 'ok',
    last_taken_by = v_actor,
    last_taken_at = now(),
    next_person = v_next,
    needs_taking_since = null,
    next_reminder_at = null,
    updated_at = now()
  where id = p_trash_id;

  insert into public.activity_log (
    type,
    actor_id,
    trash_id,
    expected_person_id,
    actual_person_id,
    voluntary,
    summary
  )
  values (
    'taken',
    v_actor,
    p_trash_id,
    v_expected,
    v_actor,
    v_voluntary,
    case
      when v_voluntary then
        v_actor_name || ' voluntarily took out ' || v_trash_name ||
        ' (it was ' || coalesce(v_expected_name, 'someone else') || '''s turn)'
      else
        v_actor_name || ' took out ' || v_trash_name
    end
  );
end;
$function$;

-- =========================================================
-- Checker called by Supabase Cron
-- =========================================================

create or replace function public.process_due_trash_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_trash record;
  v_elapsed_hours integer;
  v_reminders_created integer := 0;
begin
  for v_trash in
    select
      id,
      name,
      next_person,
      needs_taking_since
    from public.trash_types
    where status = 'needs_taking'
      and next_reminder_at is not null
      and next_reminder_at <= now()
    for update skip locked
  loop
    if v_trash.next_person is not null then
      v_elapsed_hours := greatest(
        8,
        floor(
          extract(
            epoch from (
              now() - coalesce(
                v_trash.needs_taking_since,
                now() - interval '8 hours'
              )
            )
          ) / 28800
        )::integer * 8
      );

      insert into public.notifications (
        recipient_id,
        type,
        title,
        body,
        trash_id,
        actor_id,
        url
      )
      values (
        v_trash.next_person,
        'trash_reminder',
        '⏰ ' || v_trash.name || ' still needs taking',
        'It has been ' || v_elapsed_hours ||
          ' hours since ' || v_trash.name ||
          ' was marked as Needs taking. It is still your turn to take it out.',
        v_trash.id,
        null,
        '/#home'
      );

      v_reminders_created := v_reminders_created + 1;
    end if;

    update public.trash_types
    set
      next_reminder_at = now() + interval '8 hours',
      updated_at = now()
    where id = v_trash.id
      and status = 'needs_taking';
  end loop;

  return v_reminders_created;
end;
$function$;

-- The browser must not call the scheduler helper directly.
revoke all on function public.process_due_trash_reminders()
  from public, anon, authenticated;

-- If Supabase Cron is already enabled, install/refresh the checker job.
-- The job runs every five minutes, but an actual reminder is only created
-- when next_reminder_at is due (about every eight hours).
do $do$
declare
  v_job_id bigint;
begin
  if to_regnamespace('cron') is null then
    raise notice 'Supabase Cron/pg_cron is not enabled. Enable it and schedule process_due_trash_reminders() as described in SETUP.md.';
    return;
  end if;

  for v_job_id in
    execute $sql$
      select jobid
      from cron.job
      where jobname = 'process-due-trash-reminders'
    $sql$
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'process-due-trash-reminders',
    '*/5 * * * *',
    'select public.process_due_trash_reminders();'
  );
end;
$do$;

commit;
