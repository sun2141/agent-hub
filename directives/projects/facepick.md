# FacePick Project Directive

## Project Info

- **ID**: facepick
- **Name**: FacePick
- **Path**: `/Users/sun/facepick/`
- **GitHub**: -
- **Deploy**: 개발중
- **DB 타입**: neon
- **DB 상태**: pending (Neon Postgres 연동 설정 필요)

## Tech Stack

- Frontend: (확인 필요)
- Backend: Vercel Serverless Functions (예정)
- Database: **Neon Postgres** (표준 — `directives/core/database_standards.md` 참조)

---

## Neon Postgres 연동 가이드

### 왜 Neon인가

FacePick은 Auth/Storage 등 Supabase 전용 기능이 필요하지 않으므로
Vercel 네이티브 Neon Postgres를 표준 DB로 사용합니다.

- Connection pooling 내장 → Serverless Function에서 DB 연결 수 초과 방지
- Vercel 환경변수 자동 주입
- 자동 suspend로 유휴 시 비용 없음

### 1단계: Neon DB 프로비저닝

```bash
# agent-hub에서 실행 (NEON_API_KEY, VERCEL_TOKEN 필요)
cd /Users/sun/agent-hub
python execution/setup_neon_db.py --project facepick
```

스크립트가 수행하는 작업:
1. Neon 프로젝트 `agent-hub-facepick` 생성 (ap-northeast-2 리전)
2. `DATABASE_URL` (풀링), `DATABASE_URL_UNPOOLED` 획득
3. Vercel 프로젝트 `facepick`에 환경변수 자동 설정
4. 로컬 `.env`에 `FACEPICK_DATABASE_URL` 추가

### 2단계: 클라이언트 설치

```bash
cd /Users/sun/facepick

# Neon serverless 드라이버 (Vercel Edge/Serverless 최적화)
npm install @neondatabase/serverless

# ORM (선택)
npm install drizzle-orm
npm install -D drizzle-kit
```

### 3단계: DB 연결 코드

```js
// lib/db.js (또는 lib/db.ts)
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
export default sql;
```

Drizzle ORM 사용 시:
```js
// lib/db.js
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
export const db = drizzle(sql);
```

### 4단계: 로컬 개발 환경

```bash
# facepick/.env.local
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require&pgbouncer=true
DATABASE_URL_UNPOOLED=postgresql://user:pass@host/dbname?sslmode=require
```

실제 값은 `setup_neon_db.py` 실행 후 agent-hub `.env`의
`FACEPICK_DATABASE_URL` 값을 복사합니다.

### 5단계: 마이그레이션 설정

```
facepick/
└── db/
    └── migrations/
        ├── 001_initial_schema.sql
        └── ...
```

마이그레이션 실행:
```bash
# DATABASE_URL_UNPOOLED 사용 (풀링 URL은 마이그레이션 불가)
psql $DATABASE_URL_UNPOOLED -f db/migrations/001_initial_schema.sql
```

Drizzle Kit 사용 시:
```bash
# drizzle.config.ts
export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  driver: "pg",
  dbCredentials: {
    connectionString: process.env.DATABASE_URL_UNPOOLED!,
  },
};

npx drizzle-kit push:pg
```

---

## 설정 완료 확인

다음이 모두 완료되면 DB 상태를 `active`로 업데이트하세요:
- [ ] `python execution/setup_neon_db.py --project facepick` 실행 성공
- [ ] Vercel 대시보드에서 `DATABASE_URL` 환경변수 확인
- [ ] `npm install @neondatabase/serverless` 완료
- [ ] `lib/db.js` 생성 및 연결 테스트 통과
- [ ] CLAUDE.md 프로젝트 레지스트리 DB 상태 → `active` 업데이트

---

## Monitoring Rules

### Health Check
- 배포 URL 확정 후 추가 예정

### Error Patterns
- `DATABASE_URL` 미설정 → `python execution/setup_neon_db.py --project facepick` 재실행
- Neon 연결 초과 → 풀링 URL (`DATABASE_URL`) 사용 확인
- `pgbouncer=true` 파라미터 누락 시 Serverless에서 연결 수 초과 가능

---

## Related Directives

- `directives/core/database_standards.md` - DB 선택 기준 및 Neon 표준
- `directives/deploy.md` - 배포 워크플로우
- `directives/sub_agents/db_agent.md` - DB 스키마 설계 가이드
