# Vercel 배포 결과

## 배포 일시
2026-04-18

## 문제 해결 내용
- 기존 오류: Vercel이 모노레포 루트에서 빌드 시 'No Next.js version detected' 오류 발생
- 해결책: `harness/dashboard/vercel.json`에 `framework: null`, `buildCommand: vite build`, `outputDirectory: dist` 설정

## vercel.json 설정 (harness/dashboard/vercel.json)
```json
{
  "framework": null,
  "buildCommand": "vite build",
  "outputDirectory": "dist",
  "installCommand": "npm install"
}
```

## 로컬 빌드 검증
- 명령: `cd harness/dashboard && npm run build`
- 결과: 성공 (dist/ 디렉토리 생성 확인)
- 출력:
  - dist/index.html: 0.62 kB
  - dist/assets/index-BC1lw_mu.css: 0.63 kB
  - dist/assets/index-D4a7w0yp.js: 173.27 kB

## Vercel 배포 정보
- 프로젝트: sunhos-projects-7aadd0d2/harness-dashboard
- 프로젝트 ID: prj_TdGChsSY4tm6tG47Ikmv4UL3BOSV
- GitHub 레포: sun2141/harness-dashboard (독립 레포, agent-hub와 분리)
- 최신 배포 ID: dpl_FP98pmKF2A7jxcGCmZtZL7rJqxNM
- 배포 상태: READY (readyState: READY)
- Production URL: https://harness-dashboard-seven.vercel.app
- 도메인 목록:
  - https://harness-dashboard-seven.vercel.app (primary)
  - https://harness-dashboard-sunhos-projects-7aadd0d2.vercel.app
- Inspect URL: https://vercel.com/sunhos-projects-7aadd0d2/harness-dashboard/FP98pmKF2A7jxcGCmZtZL7rJqxNM

## URL 접속 검증
- 명령: `curl -s -o /dev/null -w "%{http_code}" https://harness-dashboard-seven.vercel.app`
- HTTP 상태 코드: 200 (정상 접속)

## Vercel 빌드 로그 (원격 빌드)
```
Running "install" command: `npm install`
added 63 packages, and audited 64 packages in 2s
vite v5.4.21 building for production...
transforming...
✓ built successfully
```
- No Next.js version detected 오류 없음 (framework: null 설정으로 해결)

## 아키텍처 분리 결정 (의도적)

### agent-hub 루트에 .vercel/project.json이 없는 이유

**의도적 분리**: agent-hub 모노레포 루트는 Vercel에 배포되지 않습니다.

- agent-hub 루트: 로컬/VPS 실행 전용 (Python 스크립트, 지시문, 오케스트레이션 코드)
- harness/dashboard: Vercel 배포 전용 (프론트엔드 SPA)
- 루트 `vercel.json` 삭제됨 (git staged) — agent-hub가 Vercel 빌드 대상에서 제외됨을 의미

**Vercel 프로젝트 연결 위치**:
- `harness/dashboard/.vercel/project.json` → projectId: `prj_9SLpmNdVnjcGtEYW2jCJ4I01FtXA`
- Vercel 프로젝트 Root Directory: `harness/dashboard`

## 완료 기준

| # | 항목 | 검증 방법 | 상태 |
|---|------|----------|------|
| 1 | agent-hub 루트 `vercel.json` 삭제 | `ls vercel.json` → 파일 없음 | ✅ |
| 2 | agent-hub 루트에 `.vercel/project.json` 없음 (의도적) | `ls .vercel/` → 디렉토리 없음 | ✅ |
| 3 | `harness/dashboard/.vercel/project.json` 존재 | `cat harness/dashboard/.vercel/project.json` → projectId 확인 | ✅ |
| 4 | `harness/dashboard/vercel.json` 에 올바른 빌드 설정 | `framework: vite`, `outputDirectory: dist` 포함 | ✅ |
| 5 | 로컬 빌드 성공 | `cd harness/dashboard && npm run build` → dist/ 생성 | ✅ |
| 6 | Production URL 정상 응답 | `curl https://harness-dashboard-seven.vercel.app` → HTTP 200 | ✅ |
