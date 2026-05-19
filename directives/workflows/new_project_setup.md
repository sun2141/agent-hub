# 지침: 신규 프로젝트 설정 (new_project_setup)

새 프로젝트를 생성할 때 에이전트가 따르는 표준 설정 워크플로우입니다.
**Neon Postgres DB 설정은 필수 단계**입니다 (Auth 기능 필요 시 예외 — Supabase 사용).

## 목표

신규 프로젝트를 빠르게 시작할 수 있도록 인프라(DB, 환경변수, 디렉토리 구조)를 표준화하고 자동화합니다.

## 입력 항목

- `project_id`: 프로젝트 ID (소문자, 하이픈 허용. 예: my-app)
- `project_name`: 프로젝트 이름 (표시용. 예: My App)
- `needs_auth`: Auth 기능 필요 여부 (true → Supabase, false → Neon, 기본값: false)
- `local_path`: 로컬 경로 (기본값: `/Users/sun/{project_id}`)
- `vercel_slug`: Vercel 프로젝트 슬러그 (기본값: project_id와 동일)

---

## 전체 워크플로우

```
Step 1: 프로젝트 디렉토리 & Git 초기화
Step 2: CLAUDE.md 생성 (프로젝트 지침)
Step 3: DB 설정 (필수 — Neon 또는 Supabase)   ← 핵심
Step 4: agent-hub 레지스트리 등록
Step 5: directives/projects/{id}.md 생성
Step 6: Vercel 프로젝트 연결 (배포 예정인 경우)
Step 7: 기본 구조 검증
```

---

## Step 1: 프로젝트 디렉토리 & Git 초기화

```bash
# 로컬 경로 생성
mkdir -p /Users/sun/{project_id}
cd /Users/sun/{project_id}

# Git 초기화
git init
echo "node_modules/\n.env\n.env.local\n.tmp/\ndist/" > .gitignore

# 기본 폴더 구조 생성
mkdir -p src db/migrations
```

---

## Step 2: CLAUDE.md 생성

템플릿(`directives/templates/project_claude_md.md`)을 사용하거나 아래 내용 기반으로 생성:

```bash
# agent-hub에서
cp directives/templates/project_claude_md.md /Users/sun/{project_id}/CLAUDE.md
# project_id, project_name 등 플레이스홀더 치환
```

---

## Step 3: DB 설정 (필수)

> **DB 선택 기준**: `directives/core/database_standards.md` 참조

### 3A: Neon Postgres (기본 — Auth 불필요 프로젝트)

```bash
# agent-hub에서 실행
cd /Users/sun/agent-hub
python execution/setup_neon_db.py --project {project_id}
```

**환경변수 확인**:
```bash
# Vercel 대시보드 또는 CLI로 확인
vercel env ls --project {vercel_slug}
# DATABASE_URL, DATABASE_URL_UNPOOLED 존재 확인
```

**로컬 개발 설정**:
```bash
# {project_id}/.env.local
DATABASE_URL=<agent-hub .env의 {PROJECT_ID}_DATABASE_URL 값 복사>
DATABASE_URL_UNPOOLED=<agent-hub .env의 {PROJECT_ID}_DATABASE_URL_UNPOOLED 값 복사>
```

**클라이언트 설치**:
```bash
cd /Users/sun/{project_id}
npm install @neondatabase/serverless
# ORM 사용 시:
npm install drizzle-orm && npm install -D drizzle-kit
```

**연결 코드 생성** (`src/lib/db.js` 또는 `src/lib/db.ts`):
```js
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
export default sql;
```

### 3B: Supabase (Auth/Storage/Realtime 필요 프로젝트)

Auth, Storage, Realtime 중 하나 이상 필요한 경우에만 선택합니다.

```bash
# Supabase CLI로 프로젝트 연결
supabase link --project-ref {supabase_project_ref}

# 환경변수 설정
# SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

`directives/supabase_setup.md` 참조.

---

## Step 4: agent-hub 레지스트리 등록

CLAUDE.md, AGENTS.md, GEMINI.md의 Project Registry 테이블에 추가:

```markdown
| {project_id} | {project_name} | `/Users/sun/{project_id}/` | {github_url 또는 -} | {배포 URL 또는 개발중} | {neon 또는 supabase} | pending |
```

**DB 상태 설명**:
- `pending`: DB 설정 완료, 아직 실제 데이터 없음
- `active`: 실제 운영 중

---

## Step 5: directives/projects/{project_id}.md 생성

```bash
# agent-hub에서
cp directives/templates/project_claude_md.md directives/projects/{project_id}.md
```

반드시 포함할 항목:
- Project Info (ID, Name, Path, Deploy, DB 타입, DB 상태)
- Tech Stack
- Neon Postgres 연동 가이드 (Neon 사용 시) 또는 Supabase 설정 (Supabase 사용 시)
- Monitoring Rules
- Related Directives

---

## Step 6: Vercel 프로젝트 연결 (선택)

배포가 예정된 경우:

```bash
cd /Users/sun/{project_id}

# Vercel CLI로 프로젝트 연결
vercel link

# 또는 신규 생성
vercel
```

환경변수가 자동 주입되었는지 확인:
```bash
vercel env ls
```

---

## Step 7: 설정 검증

다음을 모두 확인 후 설정 완료로 간주합니다:

```bash
# 1. DB 연결 테스트
python execution/setup_neon_db.py --audit

# 2. 로컬 개발 서버 기동 확인
cd /Users/sun/{project_id}
npm run dev  # 또는 해당 시작 명령

# 3. 기본 DB 쿼리 테스트
# src/scripts/test-db.js 또는 해당 테스트 파일
```

검증 완료 후 레지스트리의 DB 상태를 `pending` → `active`로 업데이트합니다.

---

## 체크리스트 요약

| 단계 | 항목 | 완료 기준 |
|------|------|----------|
| 1 | 디렉토리 & Git | 폴더 생성, .gitignore 설정 |
| 2 | CLAUDE.md | 프로젝트 지침 파일 존재 |
| 3 | **DB 설정** | DATABASE_URL 환경변수 설정됨 |
| 4 | 레지스트리 등록 | CLAUDE.md 테이블에 프로젝트 추가 |
| 5 | 프로젝트 directive | directives/projects/{id}.md 존재 |
| 6 | Vercel 연결 | vercel link 완료 (배포 예정 시) |
| 7 | 검증 | DB 연결 테스트 통과 |

---

## 엣지 케이스

### DB 없이 시작해도 되는 프로젝트

크롤링 전용, 스크립트 전용 등 DB가 실제로 필요 없는 경우:
- `needs_auth` = false, DB 타입 = `none`, DB 상태 = `-`
- Step 3 건너뜀
- 향후 DB 필요 시 `python execution/setup_neon_db.py --project {id}` 실행

### Neon API 키 없는 경우

수동 설정:
1. https://console.neon.tech 에서 프로젝트 생성
2. Settings → Connection string에서 DATABASE_URL 복사
3. Vercel Dashboard → Settings → Environment Variables에서 수동 추가

### 기존 DB가 있는 프로젝트 가져오기

새 프로젝트가 아니라 기존 DB가 있는 경우 Step 3 스킵, 레지스트리에 실제 DB 타입 기재.

---

## 관련 도구

| 도구 | 역할 |
|------|------|
| `execution/setup_neon_db.py` | Neon DB 생성 + Vercel 환경변수 설정 |
| `directives/core/database_standards.md` | DB 선택 기준 |
| `directives/templates/project_claude_md.md` | 프로젝트 CLAUDE.md 템플릿 |
| `directives/supabase_setup.md` | Supabase 스키마 및 설정 가이드 |
