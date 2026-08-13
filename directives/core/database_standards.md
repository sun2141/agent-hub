# Database Standards

## DB 선택 기준

### 핵심 원칙

| 상황 | 표준 DB | 이유 |
|------|---------|------|
| 신규 프로젝트 | **Neon Postgres** | Vercel 네이티브 연동, serverless-friendly, connection pooling 내장 |
| 기존 프로젝트 (DB 있음) | **기존 DB 유지** | 마이그레이션 비용 > 이득, 데이터 무결성 우선 |
| Auth 포함 프로젝트 (Supabase) | **Supabase 유지** | Auth, Storage, Realtime 등 종속성 존재 |

### 판단 트리

```
신규 프로젝트인가?
├── YES → Auth/Storage/Realtime 필요한가?
│         ├── YES → Supabase 사용
│         └── NO  → Neon Postgres 사용 (기본)
└── NO  → 기존 DB 타입이 있는가?
          ├── YES → 기존 DB 유지 (변경 금지)
          └── NO  → Neon Postgres 설정 (execution/setup_neon_db.py 실행)
```

---

## 프로젝트별 DB 현황

| 프로젝트 | DB 타입 | 상태 | 비고 |
|---------|---------|------|------|
| agent-hub harness | neon | active | 하네스 운영 DB. `harness/.env`의 `NEON_DATABASE_URL` 사용. Neon 프로젝트 `agent-hub`, `harness` 스키마 |
| palmoni | supabase | active | Auth + DB 모두 사용 중. 마이그레이션 금지 |
| pray-crawling | none | - | 크롤링 전용, DB 불필요 |
| facepick | neon | pending | Neon 연동 설정 필요 (setup_neon_db.py 실행) |

---

## Agent Hub Harness DB

Agent Hub의 하네스 시스템은 `harness/.env`의 `NEON_DATABASE_URL`을 사용합니다.
이 DB는 프로젝트 관리, 작업 이력, 로그, rate-limit 재개 이벤트를 저장하는 운영 DB이므로
신규 프로젝트용 `execution/setup_neon_db.py`로 재생성하지 않습니다.

운영 점검:

```bash
cd /Users/sun/agent-hub/harness
PATH=/Users/sun/.nvm/versions/node/v22.22.2/bin:$PATH npm run db:health
```

스키마/인덱스 보정:

```bash
cd /Users/sun/agent-hub/harness
PATH=/Users/sun/.nvm/versions/node/v22.22.2/bin:$PATH npm run migrate:neon:schema
```

주의:
- `NEON_DATABASE_URL`은 pooled connection string (`-pooler` 호스트)을 사용합니다.
- 오래된 `pending`, `planning`, `building`, `evaluating`, `fallback_running` 작업은 새 작업을 막을 수 있으므로 `db:health`로 감지합니다.
- 하네스가 재시작되면 부팅 시 남아 있는 active 작업을 `paused`로 전환하고 `interrupted_by_harness_restart` 로그를 남깁니다. `building`/`evaluating`/`fallback_running`은 재개 시 같은 라운드를 다시 수행하도록 round를 1 되돌립니다.
- VPS/로컬 모두 하네스와 하네스가 실행하는 CLI 자식 프로세스가 Node 22를 쓰도록 `NODE_BIN`의 디렉토리를 `PATH` 맨 앞에 둡니다.
- `Claude CLI 비정상 종료 (code: 1)`와 함께 `Unexpected token '??='`가 나오면 `/usr/bin/env node`가 오래된 Node를 잡은 것입니다. `harness/scripts/start.sh`로 재시작하고 `NODE_BIN` 값과 `PATH` 순서를 먼저 확인합니다.

## Neon Postgres 표준 (신규/DB 미설정 프로젝트)

### 왜 Neon인가

- **Vercel 네이티브**: Vercel Marketplace 연동으로 환경변수 자동 주입
- **Serverless-friendly**: HTTP 기반 connection pooling 내장 (`@neondatabase/serverless`)
- **자동 절전**: 트래픽 없을 때 자동 suspend → 비용 절감
- **Branching**: DB 브랜치 기능으로 개발/스테이징 분리 가능
- **호환성**: 표준 PostgreSQL 호환 (Prisma, Drizzle, Knex 등 모두 지원)

### 연결 문자열 형식

```
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
```

Vercel Serverless Function에서는 풀링 URL 사용 권장:
```
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require&pgbouncer=true
```

### Vercel 환경변수 자동 주입 범위

Neon-Vercel 연동 시 자동으로 설정되는 변수:
- `DATABASE_URL` - 풀링 연결 URL (기본)
- `DATABASE_URL_UNPOOLED` - 직접 연결 URL (마이그레이션용)
- `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` - 개별 변수

---

## Neon 설정 절차

### 자동 설정 (권장)

```bash
# agent-hub에서 실행
python execution/setup_neon_db.py --project <project_id>

# 예시
python execution/setup_neon_db.py --project facepick
```

**스크립트가 수행하는 작업**:
1. Neon API로 DB 프로젝트 생성
2. Vercel 프로젝트와 연동 (또는 환경변수 직접 설정)
3. `DATABASE_URL` 환경변수를 Vercel 프로젝트에 등록
4. 연결 테스트 및 결과 출력
5. `.env` 파일에 로컬 개발용 `DATABASE_URL` 추가

### 수동 설정 (Vercel Dashboard)

1. Vercel Dashboard → Storage → Create Database → Neon
2. 프로젝트에 연결
3. 환경변수 자동 주입 확인

### 수동 설정 (Neon CLI)

```bash
# Neon CLI 설치
npm install -g neonctl

# 로그인
neonctl auth

# DB 생성
neonctl projects create --name <project-name>

# 연결 문자열 확인
neonctl connection-string --project-id <neon-project-id>
```

---

## 클라이언트 라이브러리 권장 설정

### Node.js / Next.js (Vercel Serverless)

```bash
npm install @neondatabase/serverless
```

```js
// lib/db.js
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
export default sql;
```

### Drizzle ORM (권장 ORM)

```bash
npm install drizzle-orm @neondatabase/serverless
npm install -D drizzle-kit
```

```js
// lib/db.js
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql);
```

### Prisma

```bash
npm install prisma @prisma/client
```

```prisma
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")  // 마이그레이션용
}
```

---

## 마이그레이션 관리

### 파일 위치

```
{project}/
└── db/
    └── migrations/
        ├── 001_initial_schema.sql
        ├── 002_add_users.sql
        └── ...
```

### 마이그레이션 실행

```bash
# Drizzle
npx drizzle-kit push

# Prisma
npx prisma migrate deploy

# 직접 SQL (DATABASE_URL_UNPOOLED 사용)
psql $DATABASE_URL_UNPOOLED -f db/migrations/001_initial_schema.sql
```

---

## 보안 원칙

1. `DATABASE_URL`은 절대 코드에 하드코딩 금지 → 환경변수만 사용
2. Vercel 배포 환경에서는 Vercel 대시보드 또는 CLI로 환경변수 관리
3. 로컬 개발용 `.env` 파일은 `.gitignore`에 포함
4. `DATABASE_URL_UNPOOLED`는 마이그레이션 전용 — API 라우트에서 사용 금지

---

## 금지 사항

- palmoni Supabase → Neon 마이그레이션 금지 (Auth 종속성)
- 기존 DB가 있는 프로젝트에 다른 DB 추가 금지 (혼재)
- production DB에 직접 스키마 변경 금지 (마이그레이션 파일 필수)
