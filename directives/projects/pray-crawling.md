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

## Related Directives

- `directives/deploy.md` - 배포 워크플로우
- `directives/run_tests.md` - 테스트 실행
