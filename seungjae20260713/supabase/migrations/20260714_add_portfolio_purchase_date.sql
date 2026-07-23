-- 포트폴리오 구매일 저장 컬럼
alter table if exists public.portfolio_holdings
	add column if not exists purchase_date date;

-- 기존 데이터는 등록일을 구매일로 한 번 채웁니다.
update public.portfolio_holdings
set purchase_date = created_at::date
where purchase_date is null
	and created_at is not null;

-- 신규 저장 시 구매일을 반드시 받도록 설정합니다.
alter table if exists public.portfolio_holdings
	alter column purchase_date set default current_date;

