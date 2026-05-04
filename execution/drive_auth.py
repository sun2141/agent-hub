"""
Google Drive OAuth2 인증 모듈
- credentials.json에서 OAuth2 클라이언트 로드
- token.json으로 토큰 캐싱 및 자동 갱신
- drive.file 스코프 사용 (앱이 만든 파일만 접근)
"""

import os
import json
import logging
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)

# Drive API 스코프: 앱이 만든/연 파일에만 접근
# 전체 Drive 접근이 필요하면 drive 스코프로 변경
SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
]

BASE_DIR = Path(__file__).parent.parent
CREDENTIALS_PATH = BASE_DIR / "credentials.json"
TOKEN_PATH = BASE_DIR / "token.json"


def get_drive_service():
    """
    Google Drive API 서비스 객체 반환.
    토큰이 만료되면 자동 갱신. 최초 실행 시 OAuth 브라우저 플로우 실행.

    Returns:
        googleapiclient.discovery.Resource: Drive API 서비스

    Raises:
        FileNotFoundError: credentials.json 없을 때
        RuntimeError: 인증 실패 시
    """
    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            f"credentials.json 파일이 없습니다: {CREDENTIALS_PATH}\n"
            "Google Cloud Console에서 OAuth2 클라이언트 ID를 발급하고 "
            "credentials.json으로 저장하세요."
        )

    creds = _load_credentials()

    if not creds or not creds.valid:
        creds = _refresh_or_reauth(creds)

    try:
        service = build("drive", "v3", credentials=creds)
        logger.info("Google Drive API 서비스 초기화 성공")
        return service
    except HttpError as e:
        raise RuntimeError(f"Drive 서비스 초기화 실패: {e}") from e


def _load_credentials() -> Credentials | None:
    """token.json에서 기존 자격증명 로드."""
    if not TOKEN_PATH.exists():
        return None

    try:
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
        logger.debug("token.json에서 자격증명 로드 완료")
        return creds
    except Exception as e:
        logger.warning(f"token.json 로드 실패 (재인증 필요): {e}")
        return None


def _refresh_or_reauth(creds: Credentials | None) -> Credentials:
    """
    토큰 갱신 시도. 실패 시 OAuth 플로우 재실행.

    VPS 환경에서는 브라우저가 없으므로 로컬에서 먼저 인증 후
    token.json을 VPS로 복사해야 합니다.
    """
    if creds and creds.expired and creds.refresh_token:
        try:
            logger.info("액세스 토큰 만료 - 자동 갱신 시도")
            creds.refresh(Request())
            _save_credentials(creds)
            logger.info("토큰 갱신 성공")
            return creds
        except Exception as e:
            logger.warning(f"토큰 갱신 실패: {e} — OAuth 재인증 필요")

    # 브라우저 기반 OAuth 플로우 (로컬 환경에서만 동작)
    logger.info("OAuth2 인증 플로우 시작 (브라우저 열림)")
    flow = InstalledAppFlow.from_client_secrets_file(
        str(CREDENTIALS_PATH), SCOPES
    )

    # VPS 환경: --noauth_local_webserver 플래그 필요 시 console 방식 사용
    try:
        creds = flow.run_local_server(port=0)
    except Exception:
        # 브라우저 없는 환경 대비
        creds = flow.run_console()

    _save_credentials(creds)
    logger.info("OAuth2 인증 완료 — token.json 저장됨")
    return creds


def _save_credentials(creds: Credentials):
    """자격증명을 token.json에 저장."""
    with open(TOKEN_PATH, "w") as f:
        f.write(creds.to_json())
    logger.debug(f"자격증명 저장: {TOKEN_PATH}")


def check_token_scopes() -> dict:
    """
    현재 token.json의 스코프 확인.
    drive.file 스코프 포함 여부를 반환.

    Returns:
        dict: {"has_drive_scope": bool, "scopes": list}
    """
    if not TOKEN_PATH.exists():
        return {"has_drive_scope": False, "scopes": [], "error": "token.json 없음"}

    try:
        with open(TOKEN_PATH) as f:
            token_data = json.load(f)

        scopes = token_data.get("scopes", [])
        if isinstance(scopes, str):
            scopes = scopes.split()

        has_drive = any("drive" in s for s in scopes)
        return {
            "has_drive_scope": has_drive,
            "scopes": scopes,
            "token_path": str(TOKEN_PATH),
        }
    except Exception as e:
        return {"has_drive_scope": False, "scopes": [], "error": str(e)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("Drive 스코프 확인:", check_token_scopes())
    try:
        service = get_drive_service()
        # 연결 테스트: 내 Drive 루트 조회
        result = service.files().list(pageSize=1, fields="files(id, name)").execute()
        print("Drive 연결 성공:", result)
    except Exception as e:
        print(f"오류: {e}")
