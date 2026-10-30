-- Point shop catalog and administrator-issued priority coupon foundation.
-- Priority passes cannot be purchased by members; only operators can issue or change them.

create table if not exists public.point_shop_products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  description text not null,
  benefit_scope text not null check (benefit_scope in ('BUSKING', 'VOM_LIVE', 'ALL')),
  purchase_mode text not null default 'COMING_SOON'
    check (purchase_mode in ('ADMIN_GRANT_ONLY', 'POINT_PURCHASE', 'COMING_SOON')),
  point_cost integer,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint point_shop_products_price_matches_mode check (
    (purchase_mode = 'POINT_PURCHASE' and point_cost is not null and point_cost > 0)
    or (purchase_mode <> 'POINT_PURCHASE' and point_cost is null)
  )
);

create table if not exists public.member_coupons (
  id uuid primary key default gen_random_uuid(),
  member_id bigint not null references public.members(id) on delete cascade,
  product_id uuid not null references public.point_shop_products(id) on delete restrict,
  status text not null default 'AVAILABLE'
    check (status in ('AVAILABLE', 'RESERVED', 'USED', 'EXPIRED', 'REVOKED')),
  issued_by uuid references auth.users(id) on delete set null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  reserved_at timestamptz,
  used_at timestamptz,
  redeemed_event_id bigint references public.events(id) on delete set null,
  issued_note text,
  updated_at timestamptz not null default now()
);

create index if not exists member_coupons_member_status_idx
  on public.member_coupons (member_id, status, issued_at desc);
create index if not exists member_coupons_product_idx
  on public.member_coupons (product_id);

alter table public.point_shop_products enable row level security;
alter table public.member_coupons enable row level security;

drop policy if exists "active point shop products are readable" on public.point_shop_products;
create policy "active point shop products are readable"
  on public.point_shop_products
  for select
  to authenticated
  using (is_active = true);

drop policy if exists "admins manage point shop products" on public.point_shop_products;
create policy "admins manage point shop products"
  on public.point_shop_products
  for all
  to authenticated
  using (
    exists (
      select 1 from public.admins a
      where a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.admins a
      where a.user_id = auth.uid()
    )
  );

drop policy if exists "members read their own coupons" on public.member_coupons;
create policy "members read their own coupons"
  on public.member_coupons
  for select
  to authenticated
  using (
    member_id in (
      select m.id
      from public.members m
      where m.auth_user_id = auth.uid()
    )
  );

drop policy if exists "admins manage member coupons" on public.member_coupons;
create policy "admins manage member coupons"
  on public.member_coupons
  for all
  to authenticated
  using (
    exists (
      select 1 from public.admins a
      where a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.admins a
      where a.user_id = auth.uid()
    )
  );

revoke all on table public.point_shop_products, public.member_coupons from anon;
grant select, insert, update, delete on table public.point_shop_products, public.member_coupons to authenticated;

insert into public.point_shop_products
  (code, title, description, benefit_scope, purchase_mode, point_cost, is_active, sort_order)
values
  (
    'BUSKING_PRIORITY_PASS',
    '버스킹 우선 참가권',
    '운영진이 발급한 쿠폰입니다. 포인트로 구매할 수 없으며, 버스킹 신청 시 우선 참가 대상 확인에 사용됩니다.',
    'BUSKING',
    'ADMIN_GRANT_ONLY',
    null,
    true,
    10
  ),
  (
    'VOM_LIVE_PRIORITY_PASS',
    'VOM LIVE 우선 참가권',
    '운영진이 발급한 쿠폰입니다. 포인트로 구매할 수 없으며, VOM LIVE 신청 시 우선 참가 대상 확인에 사용됩니다.',
    'VOM_LIVE',
    'ADMIN_GRANT_ONLY',
    null,
    true,
    20
  )
on conflict (code) do update
set
  title = excluded.title,
  description = excluded.description,
  benefit_scope = excluded.benefit_scope,
  purchase_mode = excluded.purchase_mode,
  point_cost = excluded.point_cost,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  updated_at = now();
