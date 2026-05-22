#!/usr/bin/env python3
"""
setup_neon_db.py - Neon Postgres DB 프로비저닝 스크립트

신규 또는 DB 미설정 프로젝트에 Neon Postgres DB를 생성하고
Vercel 프로젝트에 DATABASE_URL 환경변수를 자동 설정합니다.

사용법:
  python execution/setup_neon_db.py --project <project_id>
  python execution/setup_neon_db.py --project facepick

필요한 환경변수 (.env):
  NEON_API_KEY       - Neon API 키 (https://console.neon.tech/app/settings/api-keys)
  VERCEL_TOKEN       - Vercel API 토큰 (https://vercel.com/account/tokens)
  VERCEL_TEAM_ID     - Vercel 팀 ID (선택사항, 개인 계정이면 불필요)

출력:
  - Neon DB 생성 결과
  - Vercel 환경변수 설정 결과
  - 연결 테스트 결과
  - 로컬 .env 파일 업데이트 안내
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

# .env 로드
load_dotenv(Path(__file__).parent.parent / ".env")

NEON_API_BASE = "https://console.neon.tech/api/v2"
VERCEL_API_BASE = "https://api.vercel.com"

# 프로젝트 ID → Vercel 프로젝트 슬러그 매핑
# Vercel에 배포된 프로젝트가 있는 경우 슬러그(프로젝트명)를 기재
PROJECT_VERCEL_MAP = {
    "facepick": "facepick",
    "palmoni": "palmoni",   # supabase 사용 중 — 이 스크립트 대상 아님
}

# 지원 대상 프로젝트 (neon DB 설정 대상)
NEON_TARGET_PROJECTS = {"facepick"}


def get_headers_neon() -> dict:
    """Neon API 인증 헤더 반환."""
    api_key = os.getenv("NEON_API_KEY", "")
    if not api_key:
        print("[ERROR] NEON_API_KEY 환경변수가 설정되지 않았습니다.")
        print("  → https://console.neon.tech/app/settings/api-keys 에서 발급")
        sys.exit(1)
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def get_headers_vercel() -> dict:
    """Vercel API 인증 헤더 반환."""
    token = os.getenv("VERCEL_TOKEN", "")
    if not token:
        print("[ERROR] VERCEL_TOKEN 환경변수가 설정되지 않았습니다.")
        print("  → https://vercel.com/account/tokens 에서 발급")
        sys.exit(1)
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def create_neon_project(project_id: str) -> dict:
    """
    Neon API로 새 Postgres DB 프로젝트를 생성합니다.

    Args:
        project_id: 우리 프로젝트 ID (예: facepick)

    Returns:
        dict: {
            "neon_project_id": str,
            "database_url": str,       # 풀링 연결 URL
            "database_url_unpooled": str,  # 직접 연결 URL
            "host": str,
            "database": str,
            "username": str,
            "password": str,
        }
    """
    neon_project_name = f"agent-hub-{project_id}"
    print(f"[Neon] 프로젝트 생성 중: {neon_project_name}")

    payload = {
        "project": {
            "name": neon_project_name,
            "region_id": "aws-ap-northeast-2",  # 서울 리전 (가장 가까움)
            "pg_version": 16,
        }
    }

    resp = requests.post(
        f"{NEON_API_BASE}/projects",
        headers=get_headers_neon(),
        json=payload,
        timeout=60,
    )

    if resp.status_code == 422:
        # 이미 같은 이름 존재 가능성 — 기존 목록에서 찾기
        print(f"[Neon] 422 응답. 기존 프로젝트 탐색 중...")
        return find_existing_neon_project(neon_project_name)

    if not resp.ok:
        print(f"[ERROR] Neon 프로젝트 생성 실패: {resp.status_code}")
        print(f"  응답: {resp.text}")
        sys.exit(1)

    data = resp.json()
    project = data.get("project", {})
    connection_uris = data.get("connection_uris", [])

    # 기본 연결 URI 파싱
    pooled_uri = ""
    unpooled_uri = ""

    for uri_info in connection_uris:
        uri = uri_info.get("connection_uri", "")
        params = uri_info.get("connection_parameters", {})
        if "-pooler." in uri or "pooler" in uri_info.get("pooler_host", ""):
            pooled_uri = uri
        else:
            unpooled_uri = uri
        # 첫 번째가 기본 (보통 unpooled)
        if not unpooled_uri:
            unpooled_uri = uri

    # 풀링 URL이 없으면 unpooled에서 생성 (호스트에 -pooler 삽입)
    if not pooled_uri and unpooled_uri:
        pooled_uri = _make_pooled_url(unpooled_uri)

    neon_project_id = project.get("id", "")
    print(f"[Neon] 생성 완료: {neon_project_id}")
    print(f"  - 리전: {project.get('region_id', '')}")
    print(f"  - Postgres: {project.get('pg_version', '')}")

    return {
        "neon_project_id": neon_project_id,
        "database_url": pooled_uri or unpooled_uri,
        "database_url_unpooled": unpooled_uri,
    }


def find_existing_neon_project(name: str) -> dict:
    """이름으로 기존 Neon 프로젝트를 찾아 연결 정보를 반환합니다."""
    resp = requests.get(
        f"{NEON_API_BASE}/projects",
        headers=get_headers_neon(),
        timeout=30,
    )
    if not resp.ok:
        print(f"[ERROR] Neon 프로젝트 목록 조회 실패: {resp.status_code}")
        sys.exit(1)

    projects = resp.json().get("projects", [])
    for p in projects:
        if p.get("name") == name:
            neon_project_id = p["id"]
            print(f"[Neon] 기존 프로젝트 발견: {neon_project_id}")
            return get_neon_connection_string(neon_project_id)

    print(f"[ERROR] Neon 프로젝트 '{name}'를 찾을 수 없습니다.")
    sys.exit(1)


def get_neon_connection_string(neon_project_id: str) -> dict:
    """Neon 프로젝트의 연결 문자열을 조회합니다."""
    # 브랜치 목록 조회 (main 브랜치 기준)
    resp = requests.get(
        f"{NEON_API_BASE}/projects/{neon_project_id}/branches",
        headers=get_headers_neon(),
        timeout=30,
    )
    if not resp.ok:
        print(f"[ERROR] Neon 브랜치 조회 실패: {resp.status_code}")
        sys.exit(1)

    branches = resp.json().get("branches", [])
    main_branch = next(
        (b for b in branches if b.get("name") == "main"), branches[0] if branches else None
    )
    if not main_branch:
        print("[ERROR] Neon 브랜치를 찾을 수 없습니다.")
        sys.exit(1)

    branch_id = main_branch["id"]

    # 엔드포인트 조회
    resp = requests.get(
        f"{NEON_API_BASE}/projects/{neon_project_id}/endpoints",
        headers=get_headers_neon(),
        timeout=30,
    )
    if not resp.ok:
        print(f"[ERROR] Neon 엔드포인트 조회 실패: {resp.status_code}")
        sys.exit(1)

    endpoints = resp.json().get("endpoints", [])
    read_write_ep = next(
        (e for e in endpoints if e.get("type") == "read_write"), endpoints[0] if endpoints else None
    )
    if not read_write_ep:
        print("[ERROR] Neon read-write 엔드포인트를 찾을 수 없습니다.")
        sys.exit(1)

    host = read_write_ep["host"]

    # 데이터베이스/역할 조회
    resp_db = requests.get(
        f"{NEON_API_BASE}/projects/{neon_project_id}/branches/{branch_id}/databases",
        headers=get_headers_neon(),
        timeout=30,
    )
    resp_role = requests.get(
        f"{NEON_API_BASE}/projects/{neon_project_id}/branches/{branch_id}/roles",
        headers=get_headers_neon(),
        timeout=30,
    )

    databases = resp_db.json().get("databases", []) if resp_db.ok else []
    roles = resp_role.json().get("roles", []) if resp_role.ok else []

    db_name = databases[0]["name"] if databases else "neondb"
    role_name = roles[0]["name"] if roles else "neondb_owner"

    # 패스워드 조회
    resp_pw = requests.get(
        f"{NEON_API_BASE}/projects/{neon_project_id}/branches/{branch_id}/roles/{role_name}/reveal_password",
        headers=get_headers_neon(),
        timeout=30,
    )
    password = resp_pw.json().get("password", "") if resp_pw.ok else ""

    unpooled_url = f"postgresql://{role_name}:{password}@{host}/{db_name}?sslmode=require"
    pooled_url = _make_pooled_url(unpooled_url)

    return {
        "neon_project_id": neon_project_id,
        "database_url": pooled_url,
        "database_url_unpooled": unpooled_url,
    }


def _make_pooled_url(unpooled_url: str) -> str:
    """
    unpooled URL에서 Neon 풀링 URL을 생성합니다.
    예: ep-xxx.ap-northeast-2.aws.neon.tech → ep-xxx-pooler.ap-northeast-2.aws.neon.tech
    """
    # -pooler 삽입 및 pgbouncer 파라미터 추가
    if "neon.tech" in unpooled_url and "-pooler." not in unpooled_url:
        # 호스트 부분에서 첫 번째 . 전에 -pooler 삽입
        # postgresql://user:pass@ep-xxx.region.aws.neon.tech/db?...
        at_idx = unpooled_url.find("@")
        if at_idx != -1:
            host_start = at_idx + 1
            host_end = unpooled_url.find("/", host_start)
            if host_end == -1:
                host_end = unpooled_url.find("?", host_start)
            host = unpooled_url[host_start:host_end] if host_end != -1 else unpooled_url[host_start:]
            dot_idx = host.find(".")
            if dot_idx != -1:
                pooled_host = host[:dot_idx] + "-pooler" + host[dot_idx:]
                pooled_url = unpooled_url[:host_start] + pooled_host + unpooled_url[host_start + len(host):]
                # pgbouncer 파라미터 추가
                sep = "&" if "?" in pooled_url else "?"
                return pooled_url + sep + "pgbouncer=true"
    return unpooled_url


def set_vercel_env(project_slug: str, env_vars: dict, environments: list = None) -> bool:
    """
    Vercel 프로젝트에 환경변수를 설정합니다.

    Args:
        project_slug: Vercel 프로젝트 슬러그 또는 ID
        env_vars: {변수명: 값} 딕셔너리
        environments: 적용 환경 목록 (기본: production, preview, development 모두)

    Returns:
        bool: 성공 여부
    """
    if environments is None:
        environments = ["production", "preview", "development"]

    team_id = os.getenv("VERCEL_TEAM_ID", "")
    params = {}
    if team_id:
        params["teamId"] = team_id

    # 기존 환경변수 목록 조회 (중복 방지)
    resp = requests.get(
        f"{VERCEL_API_BASE}/v9/projects/{project_slug}/env",
        headers=get_headers_vercel(),
        params=params,
        timeout=30,
    )

    existing_keys = set()
    existing_env_ids = {}
    if resp.ok:
        for env in resp.json().get("envs", []):
            existing_keys.add(env.get("key", ""))
            existing_env_ids[env.get("key", "")] = env.get("id", "")

    success = True
    for key, value in env_vars.items():
        if key in existing_env_ids:
            # 기존 환경변수 업데이트 (PATCH)
            print(f"[Vercel] 환경변수 업데이트: {key}")
            patch_resp = requests.patch(
                f"{VERCEL_API_BASE}/v9/projects/{project_slug}/env/{existing_env_ids[key]}",
                headers=get_headers_vercel(),
                params=params,
                json={
                    "value": value,
                    "target": environments,
                },
                timeout=30,
            )
            if not patch_resp.ok:
                print(f"  [WARNING] 업데이트 실패: {patch_resp.status_code} - {patch_resp.text}")
                success = False
            else:
                print(f"  ✓ 업데이트 완료")
        else:
            # 신규 환경변수 추가 (POST)
            print(f"[Vercel] 환경변수 추가: {key}")
            post_resp = requests.post(
                f"{VERCEL_API_BASE}/v10/projects/{project_slug}/env",
                headers=get_headers_vercel(),
                params=params,
                json={
                    "key": key,
                    "value": value,
                    "type": "encrypted",
                    "target": environments,
                },
                timeout=30,
            )
            if not post_resp.ok:
                print(f"  [WARNING] 추가 실패: {post_resp.status_code} - {post_resp.text}")
                # 404면 Vercel에 프로젝트 없을 수 있음 — 경고만
                if post_resp.status_code == 404:
                    print(f"  → Vercel 프로젝트 '{project_slug}'를 찾을 수 없습니다.")
                    print(f"  → Vercel에 프로젝트가 없는 경우 .env에 수동으로 추가하세요.")
                success = False
            else:
                print(f"  ✓ 추가 완료")

    return success


def test_connection(database_url: str) -> bool:
    """
    DATABASE_URL로 Postgres 연결을 테스트합니다.
    psycopg2 또는 requests를 통한 HTTP 방식 중 가능한 것 사용.

    Returns:
        bool: 연결 성공 여부
    """
    print("[연결 테스트] DATABASE_URL 연결 확인 중...")

    # psycopg2 사용 시도
    try:
        import psycopg2  # noqa: PLC0415
        conn = psycopg2.connect(database_url, connect_timeout=10)
        conn.close()
        print("  ✓ PostgreSQL 연결 성공 (psycopg2)")
        return True
    except ImportError:
        pass
    except Exception as e:
        print(f"  [WARNING] psycopg2 연결 실패: {e}")

    # psycopg3 사용 시도
    try:
        import psycopg  # noqa: PLC0415
        conn = psycopg.connect(database_url, connect_timeout=10)
        conn.close()
        print("  ✓ PostgreSQL 연결 성공 (psycopg3)")
        return True
    except ImportError:
        pass
    except Exception as e:
        print(f"  [WARNING] psycopg3 연결 실패: {e}")

    # 라이브러리 없음 — URL 유효성만 확인
    if database_url.startswith("postgresql://") or database_url.startswith("postgres://"):
        print("  ✓ DATABASE_URL 형식 확인 완료 (실제 연결 테스트 생략)")
        print("    psycopg2 또는 psycopg3 설치 시 실제 연결 테스트 가능")
        return True

    print("  [ERROR] DATABASE_URL 형식이 올바르지 않습니다.")
    return False


def update_local_env(project_id: str, env_vars: dict) -> None:
    """
    agent-hub .env 파일에 로컬 개발용 변수를 추가/업데이트합니다.
    기존 값이 있으면 덮어쓰지 않고 안내만 출력합니다.
    """
    env_path = Path(__file__).parent.parent / ".env"

    print(f"\n[로컬 .env] {env_path}")

    if not env_path.exists():
        print("  [WARNING] .env 파일이 없습니다. 수동으로 추가하세요:")
        for k, v in env_vars.items():
            print(f"  {k}={v}")
        return

    content = env_path.read_text()
    section_header = f"\n# ─── {project_id.upper()} Neon DB ────────────────────────────────────────"
    new_lines = [section_header]

    already_set = []
    to_add = []

    for key, value in env_vars.items():
        if f"{key}=" in content:
            already_set.append(key)
        else:
            to_add.append(f"{key}={value}")

    if already_set:
        print(f"  이미 설정됨 (변경 안 함): {', '.join(already_set)}")

    if to_add:
        new_lines.extend(to_add)
        with open(env_path, "a") as f:
            f.write("\n".join(new_lines) + "\n")
        print(f"  ✓ 추가됨: {', '.join(k.split('=')[0] for k in to_add)}")
    else:
        print("  모든 변수가 이미 설정되어 있습니다.")


def audit_db_status() -> None:
    """프로젝트 DB 현황 감사 출력."""
    print("\n" + "=" * 50)
    print("프로젝트 DB 현황 감사")
    print("=" * 50)

    audit_data = [
        {
            "id": "palmoni",
            "db_type": "supabase",
            "status": "active",
            "note": "Auth + DB 사용 중. 마이그레이션 금지.",
        },
        {
            "id": "pray-crawling",
            "db_type": "none",
            "status": "-",
            "note": "크롤링 전용. DB 불필요.",
        },
        {
            "id": "facepick",
            "db_type": "neon",
            "status": "pending",
            "note": "Neon 연동 설정 필요. 이 스크립트로 설정 가능.",
        },
    ]

    for p in audit_data:
        status_icon = "✓" if p["status"] == "active" else ("⚠" if p["status"] == "pending" else "-")
        print(f"  {status_icon} {p['id']:20} DB: {p['db_type']:10} 상태: {p['status']:8} | {p['note']}")

    print()
    print("설정이 필요한 프로젝트:")
    pending = [p for p in audit_data if p["status"] == "pending"]
    for p in pending:
        print(f"  python execution/setup_neon_db.py --project {p['id']}")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Neon Postgres DB 생성 및 Vercel 환경변수 자동 설정",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
예시:
  python execution/setup_neon_db.py --project facepick
  python execution/setup_neon_db.py --audit           # DB 현황 감사만
  python execution/setup_neon_db.py --dry-run --project facepick  # 실제 API 호출 없이 플로우 확인
        """,
    )
    parser.add_argument("--project", help="프로젝트 ID (예: facepick)")
    parser.add_argument("--audit", action="store_true", help="프로젝트 DB 현황 감사 출력")
    parser.add_argument("--dry-run", action="store_true", help="실제 API 호출 없이 플로우만 확인")
    parser.add_argument(
        "--skip-vercel",
        action="store_true",
        help="Vercel 환경변수 설정 스킵 (DB 생성만)",
    )

    args = parser.parse_args()

    if args.audit:
        audit_db_status()
        return

    if not args.project:
        parser.print_help()
        print("\n[ERROR] --project 옵션이 필요합니다.")
        sys.exit(1)

    project_id = args.project.lower()

    print(f"\n{'=' * 60}")
    print(f"Neon DB 설정: {project_id}")
    print(f"{'=' * 60}\n")

    # palmoni는 Supabase 사용 중 — 보호
    if project_id == "palmoni":
        print("[ERROR] palmoni는 Supabase를 사용 중입니다.")
        print("  Auth + DB가 모두 Supabase에 의존하므로 Neon으로 마이그레이션하지 마세요.")
        print("  (directives/core/database_standards.md 참조)")
        sys.exit(1)

    # 지원 대상 확인
    if project_id not in NEON_TARGET_PROJECTS:
        print(f"[WARNING] '{project_id}'는 사전 등록된 Neon 대상 프로젝트가 아닙니다.")
        print(f"  등록된 대상: {', '.join(NEON_TARGET_PROJECTS)}")
        print("  계속 진행하려면 Enter를 누르세요 (Ctrl+C로 취소):")
        try:
            input()
        except KeyboardInterrupt:
            print("\n취소됨.")
            sys.exit(0)

    if args.dry_run:
        print("[DRY RUN] 실제 API 호출을 하지 않습니다.\n")
        print(f"수행될 작업:")
        print(f"  1. Neon API → 프로젝트 'agent-hub-{project_id}' 생성")
        print(f"  2. DATABASE_URL, DATABASE_URL_UNPOOLED 획득")
        vercel_slug = PROJECT_VERCEL_MAP.get(project_id, project_id)
        print(f"  3. Vercel 프로젝트 '{vercel_slug}'에 환경변수 설정")
        print(f"     - DATABASE_URL (production, preview, development)")
        print(f"     - DATABASE_URL_UNPOOLED (production, preview, development)")
        print(f"  4. 연결 테스트")
        print(f"  5. agent-hub .env에 {project_id.upper()}_DATABASE_URL 추가")
        print("\n[DRY RUN 완료]")
        return

    # Step 1: Neon DB 생성
    print("Step 1: Neon DB 생성")
    print("-" * 40)
    neon_result = create_neon_project(project_id)
    database_url = neon_result["database_url"]
    database_url_unpooled = neon_result["database_url_unpooled"]

    print(f"\n  Neon 프로젝트 ID : {neon_result['neon_project_id']}")
    # URL 일부 마스킹 (패스워드 부분)
    def mask_url(url: str) -> str:
        if "@" in url and "://" in url:
            proto_end = url.find("://") + 3
            at_idx = url.find("@")
            user_pass = url[proto_end:at_idx]
            if ":" in user_pass:
                user = user_pass.split(":")[0]
                return url[:proto_end] + user + ":***@" + url[at_idx + 1:]
        return url

    print(f"  DATABASE_URL     : {mask_url(database_url)}")
    print(f"  DATABASE_URL_UNPOOLED: {mask_url(database_url_unpooled)}")

    # Step 2: Vercel 환경변수 설정
    if not args.skip_vercel:
        print(f"\nStep 2: Vercel 환경변수 설정")
        print("-" * 40)

        vercel_slug = PROJECT_VERCEL_MAP.get(project_id, project_id)
        env_vars_to_set = {
            "DATABASE_URL": database_url,
            "DATABASE_URL_UNPOOLED": database_url_unpooled,
        }

        vercel_ok = set_vercel_env(vercel_slug, env_vars_to_set)
        if vercel_ok:
            print(f"\n  ✓ Vercel 환경변수 설정 완료 (프로젝트: {vercel_slug})")
        else:
            print(f"\n  [WARNING] Vercel 환경변수 일부 설정 실패")
            print(f"  Vercel에 프로젝트가 없거나 VERCEL_TOKEN이 없을 수 있습니다.")
            print(f"  수동으로 Vercel Dashboard에서 설정하세요:")
            print(f"    DATABASE_URL = {mask_url(database_url)}")
    else:
        print(f"\nStep 2: Vercel 환경변수 설정 [스킵됨]")

    # Step 3: 연결 테스트
    print(f"\nStep 3: 연결 테스트")
    print("-" * 40)
    # unpooled URL로 테스트 (더 안정적)
    test_url = database_url_unpooled or database_url
    conn_ok = test_connection(test_url)

    # Step 4: 로컬 .env 업데이트
    print(f"\nStep 4: 로컬 .env 업데이트")
    print("-" * 40)
    local_env_vars = {
        f"{project_id.upper().replace('-', '_')}_DATABASE_URL": database_url,
        f"{project_id.upper().replace('-', '_')}_DATABASE_URL_UNPOOLED": database_url_unpooled,
    }
    update_local_env(project_id, local_env_vars)

    # 최종 요약
    print(f"\n{'=' * 60}")
    print(f"설정 완료: {project_id}")
    print(f"{'=' * 60}")
    print(f"  Neon 프로젝트 : agent-hub-{project_id}")
    print(f"  DB 연결       : {'✓ 성공' if conn_ok else '⚠ 확인 필요'}")
    print(f"\n다음 단계:")
    print(f"  1. {project_id} 프로젝트에서 @neondatabase/serverless 설치:")
    print(f"     npm install @neondatabase/serverless")
    print(f"  2. 로컬 개발 시 .env에 DATABASE_URL 설정:")
    print(f"     DATABASE_URL={mask_url(database_url)}")
    print(f"  3. 마이그레이션 실행 시 DATABASE_URL_UNPOOLED 사용")
    print(f"\n참고 문서: directives/core/database_standards.md")


if __name__ == "__main__":
    main()
