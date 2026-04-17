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
- 프로젝트: sunhos-projects-7aadd0d2/dashboard
- 프로젝트 ID: prj_9SLpmNdVnjcGtEYW2jCJ4I01FtXA
- Root Directory: harness/dashboard (Vercel에서 이 디렉토리에서 직접 배포 실행)
- 배포 ID: dpl_GvbDdssnQYpHV9NsciWtF7s7qp2e
- 배포 상태: READY (readyState: READY)
- Production URL: https://dashboard-tau-eight-55.vercel.app
- Preview URL: https://dashboard-c4ysqh5ru-sunhos-projects-7aadd0d2.vercel.app
- Inspect URL: https://vercel.com/sunhos-projects-7aadd0d2/dashboard/GvbDdssnQYpHV9NsciWtF7s7qp2e

## URL 접속 검증
- 명령: `curl -s -o /dev/null -w "%{http_code}" https://dashboard-tau-eight-55.vercel.app`
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
