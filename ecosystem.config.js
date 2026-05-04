/**
 * PM2 프로세스 관리 설정
 * VPS에서 GitHub-Drive Sync 에이전트를 상시 실행
 *
 * 사용: pm2 start ecosystem.config.js
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
  ],
};
