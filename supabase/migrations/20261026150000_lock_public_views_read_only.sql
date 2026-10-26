-- Keep public views readable where they already are, but never writable via the Data API.
-- Views normally bypass RLS unless explicitly created with security_invoker.
do $$
declare
  public_view record;
begin
  for public_view in
    select viewname
    from pg_views
    where schemaname = 'public'
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on table public.%I from anon, authenticated',
      public_view.viewname
    );
    execute format(
      'grant select on table public.%I to anon, authenticated',
      public_view.viewname
    );
  end loop;
end
$$;

-- Migrations run as postgres. New relations must now opt into client access explicitly.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
