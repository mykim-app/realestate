-- 부동산 조회 사이트 테이블 (Supabase SQL Editor에서 한 번 실행)
-- 모든 접근은 Edge Function(서비스 키)만 사용하므로 RLS를 켜고 정책은 만들지 않습니다.

create table if not exists places (
  id uuid primary key default gen_random_uuid(),
  name text not null,            -- 관심 위치 이름(사용자 입력)
  memo text,
  lat double precision not null, -- 위도
  lng double precision not null, -- 경도
  pnu text not null unique,      -- 필지고유번호(19자리)
  addr text,                     -- 지번 주소
  jibun text,                    -- 지번(지목 포함)
  created_at timestamptz not null default now()
);

-- 주 단위 저장 기록: 관심 위치별 공시지가·최근 실거래 요약
create table if not exists snapshots (
  place_id uuid not null references places(id) on delete cascade,
  week date not null,            -- 해당 주 월요일(한국시간)
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (place_id, week)
);

-- 한국부동산원 주간 아파트 가격 변동률(%)
create table if not exists region_weekly (
  kind text not null,            -- 'sale'(매매) | 'jeonse'(전세)
  region text not null,
  wrttime text not null,         -- 원자료 작성시점 식별값
  value double precision,
  primary key (kind, region, wrttime)
);

alter table places enable row level security;
alter table snapshots enable row level security;
alter table region_weekly enable row level security;
