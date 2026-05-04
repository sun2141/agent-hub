"""
Google Drive OAuth2 인증 모듈
- credentials.json에서 OAuth2 클라이언트 로드
- token.json으로 토큰 캐싱 및 자동 갱신
- drive 스코프 사용 (사용자의 모든 Drive 파일 접근 가능)

스코프 설명:
  drive                 — 전체 Drive 읽기/쓰기 (앱 외부 생성 파일 포함)
  drive.file            — 앱이 만들거나 연 파일만 접근 (더 제한적)
  drive.metadata.readonly — 파일 메타데이터만 읽기

현재 설정: drive 스코프 사용
  이유: 동기화 에이전트는 사용자가 직접 Drive에 추가한 파일도 감지해야 함.
  앱 외부에서 생성한 기존 파일은 drive.file 스코프로는 접근 불가.

기존 token.json이 drive.file 스코프로 발급된 경우 재인증 필요:
  rm token.json && python execution/drive_auth.py
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

# Drive API 스코프: 전체 Drive 접근 (앱 외부 생성 파일 포함)
# drive.file 대신 drive 스코프를 사용해야 기존 폴더 폴링이 가능함
SCOPES = [
    "https://www.googleapis.com/auth/drive",
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
    전체 Drive 접근(drive) 스코프 포함 여부를 반환.

    Returns:
        dict: {
            "has_drive_scope": bool,   # drive 스코프 포함 여부
            "has_full_drive": bool,    # drive (전체) 스코프 여부 (drive.file이 아닌)
            "scopes": list,
            "needs_reauth": bool,      # 재인증 필요 여부 (drive.file만 있는 경우)
        }
    """
    if not TOKEN_PATH.exists():
        return {
            "has_drive_scope": False,
            "has_full_drive": False,
            "scopes": [],
            "needs_reauth": True,
            "error": "token.json 없음",
        }

    try:
        with open(TOKEN_PATH) as f:
            token_data = json.load(f)

        scopes = token_data.get("scopes", [])
        if isinstance(scopes, str):
            scopes = scopes.split()

        has_drive = any("drive" in s for s in scopes)
        # drive.file만 있고 drive 전체 스코프가 없으면 재인증 필요
        full_drive_scope = "https://www.googleapis.com/auth/drive"
        has_full_drive = full_drive_scope in scopes
        drive_file_only = any("drive.file" in s for s in scopes) and not has_full_drive

        return {
            "has_drive_scope": has_drive,
            "has_full_drive": has_full_drive,
            "scopes": scopes,
            "needs_reauth": drive_file_only,
            "token_path": str(TOKEN_PATH),
        }
    except Exception as e:
        return {
            "has_drive_scope": False,
            "has_full_drive": False,
            "scopes": [],
            "needs_reauth": True,
            "error": str(e),
        }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    scope_info = check_token_scopes()
    print("Drive 스코프 확인:", scope_info)

    if scope_info.get("needs_reauth"):
        print(
            "\n⚠️  재인증 필요: token.json이 drive.file 스코프로만 발급되어 있습니다.\n"
            "기존 Drive 파일(앱 외부 생성) 접근을 위해 drive 스코프가 필요합니다.\n"
            "  rm token.json && python execution/drive_auth.py\n"
            "를 실행하면 브라우저에서 재인증이 시작됩니다."
        )

    try:
        service = get_drive_service()
        # 연결 테스트: 내 Drive 루트 조회
        result = service.files().list(pageSize=1, fields="files(id, name)").execute()
        print("Drive 연결 성공:", result)
    except Exception as e:
        print(f"오류: {e}")
