# Pray-crawling Project Directive

## Project Info

- **ID**: pray-crawling
- **Name**: Pray-crawling
- **Path**: `/Users/sun/pray-crawling`
- **GitHub**: https://github.com/sun2141/pray-crawling
- **Deploy**: 개발중

## Tech Stack

-

## Description

youtube 기도문 영상에서 기도문을 추출하는 시스템

## Monitoring Rules

### Health Check
- URL: (배포 URL 설정 필요)
- Interval: 5분
- Alert: 3회 연속 실패 시 텔레그램 알림

## Auto-Fix Rules

1. **빌드 실패**: 에러 로그 분석 후 자동 수정 시도
2. **배포 실패**: 환경 변수 및 설정 확인
3. **런타임 에러**: 로그 분석 후 롤백 판단

## Backlog

<!-- 매니저 루프(/scan)가 읽는 "의도 신호"입니다.
     하고 싶은 작업을 한 줄씩 적으면 다음 스캔에서 작업 후보로 올라옵니다.
     - [ ] 미완료 (신호로 잡힘)  /  - [x] 완료 (제외됨)
     여기가 비어 있으면 그 프로젝트는 제안 대상에서 빠집니다 —
     하네스가 자기 실패 이력만 보고 잡일을 만들어내지 않도록 하는 기본 동작입니다. -->

## Related Directives

- `directives/deploy.md` - 배포 워크플로우
- `directives/run_tests.md` - 테스트 실행
