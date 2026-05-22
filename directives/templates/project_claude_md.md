# {PROJECT_NAME} - Agent Instructions

> 이 파일은 {PROJECT_NAME} 프로젝트 전용 Agent 지침입니다.

## Project Overview

**{PROJECT_NAME}** - {PROJECT_DESCRIPTION}

- **Tech Stack**: {TECH_STACK}
- **Deployment**: {DEPLOYMENT_INFO}
- **Path**: `{PROJECT_LOCAL_PATH}`

## Project Structure

```
{PROJECT_ID}/
├── src/           # 소스 코드
├── tests/         # 테스트
└── ...
```

## Development Commands

```bash
# 개발 서버
npm run dev

# 빌드
npm run build

# 테스트
npm run test
```

## Agent Guidelines

### 이 프로젝트에서 작업 시

1. **프로젝트 목적에 집중** - {PROJECT_FOCUS}
2. **배포 환경 고려** - {DEPLOYMENT_CONSIDERATIONS}
3. **테스트 작성** - 새 기능 추가 시 테스트 포함

### 금지 사항

- 이 프로젝트에서 자동화/인프라 작업 하지 말 것
- agent-hub 전용 작업은 `{AGENT_HUB_ROOT}/`에서 수행

---

## Central Hub Connection

이 프로젝트는 **agent-hub** (`{AGENT_HUB_ROOT}/`)와 연결됩니다.

**연결 방식**:
- agent-hub가 이 프로젝트를 모니터링
- 오류 발생 시 자동 감지 및 알림
- 프로젝트별 directive: `{AGENT_HUB_ROOT}/directives/projects/{PROJECT_ID}.md`

**참조 문서**:
- 전체 인프라: `{AGENT_HUB_ROOT}/CLAUDE.md`
- 자동화 레지스트리: `{AGENT_HUB_ROOT}/directives/automation_registry.md`

---

## Git Info

- **Repository**: {GITHUB_REPO}
- **Branch Strategy**: {BRANCH_STRATEGY}
