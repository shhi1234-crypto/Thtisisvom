-- Member profile edits are handled only by the authenticated vom-access Edge Function.
-- This prevents a member-owned browser session from changing any other members column.
begin;

revoke update on table public.members from anon, authenticated;
drop policy if exists "members owner update" on public.members;

commit;
