-- 국내 DART / 미국 SEC 공식 공시 기반 기업개요·테마 분류 저장소
-- 기존 테이블은 건드리지 않고 새 테이블만 추가합니다.

create table if not exists public.stock_company_profiles (
  market text not null check (market in ('KR', 'US')),
  ticker text not null,
  name text not null,
  currency text not null check (currency in ('KRW', 'USD')),
  exchange text not null default '',
  country text not null default '',
  official_industry text not null default '',
  sector text not null default '',
  description text not null default '',
  business_summary text not null default '',
  main_products text[] not null default '{}',
  competitors text[] not null default '{}',
  website text not null default '',
  evidence_excerpt text not null default '',
  source_type text not null default 'NONE' check (source_type in ('DART', 'SEC', 'NONE')),
  source_url text not null default '',
  source_document_id text not null default '',
  source_date date,
  confidence integer not null default 0 check (confidence between 0 and 100),
  data_quality text not null default 'insufficient' check (data_quality in ('official', 'partial', 'insufficient')),
  review_status text not null default 'candidate' check (review_status in ('candidate', 'approved', 'rejected')),
  admin_verified boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (market, ticker)
);

create table if not exists public.stock_theme_relations (
  market text not null check (market in ('KR', 'US')),
  ticker text not null,
  name text not null,
  currency text not null check (currency in ('KRW', 'USD')),
  theme_key text not null,
  theme_label text not null,
  relation_level text not null check (relation_level in ('핵심사업', '관련사업', '공급·투자관계', '연관')),
  reason text not null default '',
  evidence text not null default '',
  confidence integer not null default 0 check (confidence between 0 and 100),
  source_type text not null check (source_type in ('DART', 'SEC')),
  source_url text not null default '',
  source_document_id text not null default '',
  source_date date,
  review_status text not null default 'candidate' check (review_status in ('candidate', 'approved', 'rejected')),
  admin_verified boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (market, ticker, theme_key),
  foreign key (market, ticker)
    references public.stock_company_profiles (market, ticker)
    on delete cascade
);

create index if not exists stock_company_profiles_market_idx
  on public.stock_company_profiles (market, updated_at desc);

create index if not exists stock_theme_relations_theme_idx
  on public.stock_theme_relations (market, theme_key, admin_verified desc, confidence desc);

create index if not exists stock_theme_relations_review_idx
  on public.stock_theme_relations (review_status, admin_verified, updated_at desc);

alter table public.stock_company_profiles enable row level security;
alter table public.stock_theme_relations enable row level security;

-- 기업개요·테마 근거는 공개 시장정보이므로 앱 사용자에게 읽기만 허용합니다.
drop policy if exists "company profiles are readable" on public.stock_company_profiles;
create policy "company profiles are readable"
  on public.stock_company_profiles
  for select
  using (true);

drop policy if exists "theme relations are readable" on public.stock_theme_relations;
create policy "theme relations are readable"
  on public.stock_theme_relations
  for select
  using (review_status <> 'rejected');

-- 쓰기 정책은 만들지 않습니다.
-- 서버의 SUPABASE_SERVICE_ROLE_KEY 또는 SUPABASE_SECRET_KEY만 RLS를 우회해 저장·검수합니다.
