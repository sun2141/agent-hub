/**
 * PM2 프로세스 관리 설정
 * VPS에서 GitHub-Drive Sync 에이전트 + Harness를 상시 실행
 *
 * 사용: pm2 start ecosystem.config.js [--only <app-name>]
 *
 * ⚠️ 시크릿 로테이션 시 주의 (2026-08-13 사고 기록):
 * pm2는 최초 `pm2 start`/`pm2 restart --update-env` 시점 셸의 env를
 * 내부 dump.pm2에 스냅샷으로 저장해두고, 이후 재시작 때 그 스냅샷을
 * 재사용한다. dotenv는 이미 존재하는 process.env를 덮어쓰지 않으므로,
 * .env 파일만 고치고 `pm2 restart`(--update-env 포함)해도 옛 값이
 * 계속 쓰이는 경우가 있다. 이 앱들은 env에 시크릿을 직접 넣지 않고
 * dotenv(.env 파일)에만 의존하므로, .env 값을 바꾼 뒤 반영이 안 되면
 * `pm2 delete <name> && pm2 start ecosystem.config.js --only <name> && pm2 save`
 * 로 스냅샷 자체를 새로 캡처해야 한다.
 */
module.exports = {
  apps: [
    {
      name: "github-drive-sync",
      script: "execution/github_drive_webhook.py",
      interpreter: "python3",
      cwd: "/root/workspace",

      // 재시작 정책
      autorestart: true,
      watch: false,           // 파일 감시 비활성화 (운영 환경)
      max_restarts: 10,
      restart_delay: 5000,    // 재시작 전 5초 대기

      // 환경 변수
      env: {
        WEBHOOK_PORT: "8080",
        PYTHONUNBUFFERED: "1",  // 로그 즉시 출력
      },

      // 로그 설정
      log_file: ".tmp/github-drive-sync.log",
      out_file: ".tmp/github-drive-sync-out.log",
      error_file: ".tmp/github-drive-sync-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      // 메모리 제한 (4GB 서버에서 안전하게)
      max_memory_restart: "512M",
    },
    {
      name: "harness",
      script: "src/index.js",
      cwd: "./harness",

      // 재시작 정책
      autorestart: true,
      watch: false,
      max_restarts: 15,
      restart_delay: 5000,

      // 시크릿은 harness/.env(dotenv)에서만 로드 — 여기 env에 넣지 않음
      env: {},

      // 로그는 harness 자체 로깅(콘솔) + pm2 기본 로그 사용
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,

      max_memory_restart: "1G",
    },
  ],
};
