"""
텔레그램 알림 모듈 (GitHub-Drive 동기화 전용)
- 동기화 성공/실패/오류 알림
- 기존 telegram_design_handler.py와 독립적으로 동작
"""

import os
import logging
import requests
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

TELEGRAM_API = "https://api.telegram.org"


def _get_bot_config() -> tuple[str, str]:
    """환경 변수에서 봇 토큰과 채팅 ID 로드."""
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        raise ValueError(
            "TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 환경 변수가 설정되지 않았습니다."
        )
    return token, chat_id


def send_message(text: str, parse_mode: str = "HTML") -> bool:
    """
    텔레그램 메시지 전송.

    Args:
        text: 전송할 메시지 (HTML 또는 Markdown)
        parse_mode: "HTML" 또는 "MarkdownV2"

    Returns:
        bool: 전송 성공 여부
    """
    try:
        token, chat_id = _get_bot_config()
        url = f"{TELEGRAM_API}/bot{token}/sendMessage"
        response = requests.post(
            url,
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": parse_mode,
            },
            timeout=10,
        )
        response.raise_for_status()
        logger.debug(f"텔레그램 알림 전송 성공")
        return True
    except ValueError as e:
        logger.warning(f"텔레그램 설정 없음: {e}")
        return False
    except requests.RequestException as e:
        logger.error(f"텔레그램 전송 실패: {e}")
        return False


def notify_sync_success(
    repo: str,
    branch: str,
    files_synced: list[str],
    files_skipped: int = 0,
    commit_sha: str = "",
    commit_message: str = "",
):
    """동기화 성공 알림."""
    count = len(files_synced)
    sha_short = commit_sha[:7] if commit_sha else "?"
    files_preview = "\n".join(f"  • {f}" for f in files_synced[:5])
    if count > 5:
        files_preview += f"\n  ... 외 {count - 5}개"

    msg = (
        f"✅ <b>Drive 동기화 완료</b>\n"
        f"📦 저장소: <code>{repo}</code> ({branch})\n"
        f"🔖 커밋: <code>{sha_short}</code> {_escape_html(commit_message[:60])}\n"
        f"📁 동기화: {count}개 | 스킵: {files_skipped}개\n"
        f"\n{files_preview}"
    )
    send_message(msg)


def notify_sync_failure(
    repo: str,
    branch: str,
    failed_files: list[dict],
    commit_sha: str = "",
):
    """동기화 실패 알림."""
    sha_short = commit_sha[:7] if commit_sha else "?"
    errors_preview = "\n".join(
        f"  ❌ {f['file']}: {f['error'][:80]}" for f in failed_files[:3]
    )
    if len(failed_files) > 3:
        errors_preview += f"\n  ... 외 {len(failed_files) - 3}개"

    msg = (
        f"🚨 <b>Drive 동기화 실패</b>\n"
        f"📦 저장소: <code>{repo}</code>\n"
        f"🔖 커밋: <code>{sha_short}</code>\n"
        f"❌ 실패 파일: {len(failed_files)}개\n"
        f"\n{errors_preview}\n"
        f"\n재시도 로직이 동작 중입니다."
    )
    send_message(msg)


def notify_webhook_received(
    repo: str,
    event_type: str,
    branch: str,
    pusher: str = "",
    file_count: int = 0,
):
    """Webhook 수신 알림 (대용량 push 시에만 전송 권장)."""
    msg = (
        f"📡 <b>Webhook 수신</b>\n"
        f"이벤트: <code>{event_type}</code>\n"
        f"저장소: <code>{repo}</code> ({branch})\n"
        f"푸셔: {_escape_html(pusher)}\n"
        f"변경 파일: {file_count}개"
    )
    send_message(msg)


def notify_auth_error(error: str):
    """Google Drive 인증 오류 알림."""
    msg = (
        f"⚠️ <b>Drive 인증 오류</b>\n"
        f"<code>{_escape_html(error[:200])}</code>\n"
        f"\n<b>조치 필요:</b> token.json 재발급\n"
        f"<code>python execution/drive_auth.py</code>"
    )
    send_message(msg)


def notify_rate_limit(service: str, retry_after: int = 60):
    """API 레이트 리밋 알림."""
    msg = (
        f"⏳ <b>Rate Limit</b>\n"
        f"서비스: {service}\n"
        f"{retry_after}초 후 재시도합니다."
    )
    send_message(msg)


def _escape_html(text: str) -> str:
    """HTML 특수문자 이스케이프."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    from dotenv import load_dotenv
    load_dotenv()

    result = send_message("🔧 <b>GitHub-Drive 동기화 에이전트 테스트</b>\n연결 확인 중...")
    print("전송 결과:", result)
