# Reddit Insight Project Directive

## Project Info

- **ID**: reddit-insight
- **Name**: Reddit Insight
- **Path**: `/Users/sun/reddit-insight/`
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

Reddit Insight는 Reddit 데이터 수집/분석 특성상 Auth/Storage 등 Supabase 전용 기능이
불필요하므로 Vercel 네이티브 Neon Postgres를 표준 DB로 사용합니다.

- Reddit API 데이터를 주기적으로 적재 → Serverless cron 친화적
- Connection pooling 내장 → 다량의 짧은 쿼리에 최적
- Neon Branching으로 데이터 스냅샷 브랜치 생성 가능

### 1단계: Neon DB 프로비저닝

```bash
# agent-hub에서 실행 (NEON_API_KEY, VERCEL_TOKEN 필요)
cd /Users/sun/agent-hub
python execution/setup_neon_db.py --project reddit-insight
```

스크립트가 수행하는 작업:
1. Neon 프로젝트 `agent-hub-reddit-insight` 생성 (ap-northeast-2 리전)
2. `DATABASE_URL` (풀링), `DATABASE_URL_UNPOOLED` 획득
3. Vercel 프로젝트 `reddit-insight`에 환경변수 자동 설정
4. 로컬 `.env`에 `REDDIT_INSIGHT_DATABASE_URL` 추가

### 2단계: 클라이언트 설치

```bash
cd /Users/sun/reddit-insight

# Neon serverless 드라이버
npm install @neondatabase/serverless

# ORM (선택 — Reddit 데이터는 Drizzle 권장)
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
# reddit-insight/.env.local
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require&pgbouncer=true
DATABASE_URL_UNPOOLED=postgresql://user:pass@host/dbname?sslmode=require
```

실제 값은 `setup_neon_db.py` 실행 후 agent-hub `.env`의
`REDDIT_INSIGHT_DATABASE_URL` 값을 복사합니다.

### 5단계: Reddit Insight 권장 스키마

Reddit 데이터 수집 프로젝트를 위한 기본 테이블 구조:

```sql
-- Reddit 서브레딧 정보
CREATE TABLE subreddits (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    subscribers INTEGER,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reddit 포스트 수집
CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    subreddit_id TEXT REFERENCES subreddits(id),
    title TEXT NOT NULL,
    author TEXT,
    score INTEGER DEFAULT 0,
    num_comments INTEGER DEFAULT 0,
    url TEXT,
    selftext TEXT,
    created_utc TIMESTAMPTZ NOT NULL,
    collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 분석 결과 캐시
CREATE TABLE insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subreddit_id TEXT REFERENCES subreddits(id),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    insight_type TEXT NOT NULL,  -- 'trend', 'sentiment', 'topic'
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_posts_subreddit ON posts(subreddit_id);
CREATE INDEX idx_posts_created ON posts(created_utc DESC);
CREATE INDEX idx_insights_subreddit_type ON insights(subreddit_id, insight_type);
```

### 6단계: 마이그레이션 관리

```
reddit-insight/
└── db/
    └── migrations/
        ├── 001_initial_schema.sql
        ├── 002_add_insights.sql
        └── ...
```

```bash
# 마이그레이션 실행 (DATABASE_URL_UNPOOLED 사용)
psql $DATABASE_URL_UNPOOLED -f db/migrations/001_initial_schema.sql
```

---

## 설정 완료 확인

다음이 모두 완료되면 DB 상태를 `active`로 업데이트하세요:
- [ ] `python execution/setup_neon_db.py --project reddit-insight` 실행 성공
- [ ] Vercel 대시보드에서 `DATABASE_URL` 환경변수 확인
- [ ] `npm install @neondatabase/serverless` 완료
- [ ] `lib/db.js` 생성 및 연결 테스트 통과
- [ ] 기본 스키마 마이그레이션 완료
- [ ] CLAUDE.md 프로젝트 레지스트리 DB 상태 → `active` 업데이트

---

## Monitoring Rules

### Health Check
- 배포 URL 확정 후 추가 예정

### Error Patterns
- `DATABASE_URL` 미설정 → `python execution/setup_neon_db.py --project reddit-insight` 재실행
- Reddit API rate limit → 수집 간격 조정 (일반적으로 60req/min)
- Neon 연결 풀 초과 → `pgbouncer=true` 파라미터 및 풀링 URL 확인
- JSONB 쿼리 성능 저하 → GIN 인덱스 추가: `CREATE INDEX ON insights USING gin(data)`

---

## Related Directives

- `directives/core/database_standards.md` - DB 선택 기준 및 Neon 표준
- `directives/deploy.md` - 배포 워크플로우
- `directives/sub_agents/db_agent.md` - DB 스키마 설계 가이드
