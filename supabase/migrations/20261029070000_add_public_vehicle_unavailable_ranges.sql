create or replace function public.get_vehicle_unavailable_ranges(
  p_vehicle_id uuid,
  p_start_date date default current_date,
  p_end_date date default (current_date + 730)
)
returns table (start_date date, end_date date, status text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_vehicle_id is null
     or p_start_date is null
     or p_end_date is null
     or p_end_date <= p_start_date
     or p_end_date > p_start_date + 731 then
    raise exception 'Invalid availability date range.';
  end if;

  if not exists (
    select 1 from public.vehicles v
    where v.id = p_vehicle_id and v.status = 'published' and v.verified = true
  ) then
    return;
  end if;

  return query
  select a.start_date, a.end_date, 'blocked'::text
  from public.vehicle_availability a
  where a.vehicle_id = p_vehicle_id
    and a.status in ('blocked', 'booked')
    and a.start_date < p_end_date and a.end_date > p_start_date
  union all
  select b.pickup_date, b.return_date,
    case when b.status = 'confirmed' then 'booked'::text else 'pending'::text end
  from public.bookings b
  where b.vehicle_id = p_vehicle_id
    and b.status in ('payment_pending', 'confirmed')
    and b.pickup_date < p_end_date and b.return_date > p_start_date;
end;
$function$;

revoke all on function public.get_vehicle_unavailable_ranges(uuid, date, date) from public;
grant execute on function public.get_vehicle_unavailable_ranges(uuid, date, date) to anon, authenticated;
