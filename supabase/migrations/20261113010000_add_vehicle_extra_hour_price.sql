alter table public.vehicles
  add column if not exists extra_hour_price numeric(12,2) not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.vehicles'::regclass
      and conname = 'vehicles_extra_hour_price_nonnegative'
  ) then
    alter table public.vehicles
      add constraint vehicles_extra_hour_price_nonnegative
      check (extra_hour_price >= 0);
  end if;
end
$$;

create or replace function public.set_my_vehicle_extra_hour_price(
  p_vehicle_id uuid,
  p_extra_hour_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.';
  end if;

  if p_vehicle_id is null
     or p_extra_hour_price is null
     or p_extra_hour_price < 0 then
    raise exception 'Enter a valid extra-hour price of ₦0 or more.';
  end if;

  update public.vehicles
  set extra_hour_price = round(p_extra_hour_price, 2),
      updated_at = now()
  where id = p_vehicle_id
    and owner_id = auth.uid();

  if not found then
    raise exception 'Vehicle not found or you do not own this listing.';
  end if;

  select jsonb_build_object(
    'vehicle_id', id,
    'extra_hour_price', extra_hour_price
  )
  into v_result
  from public.vehicles
  where id = p_vehicle_id;

  return v_result;
end;
$function$;

revoke all on function public.set_my_vehicle_extra_hour_price(uuid,numeric) from public;
grant execute on function public.set_my_vehicle_extra_hour_price(uuid,numeric) to authenticated;
