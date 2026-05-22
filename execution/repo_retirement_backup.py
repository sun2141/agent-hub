#!/usr/bin/env python3
"""
Back up GitHub repositories before archive/delete cleanup.

This script is intentionally non-destructive. It creates:
- bare git mirror clones
- portable git bundles
- GitHub metadata snapshots (repo, issues, PRs, releases, deployments, branches)
- local checkout status/diff snapshots for known local clones
- manifest.json and REPORT.md with verification results

Default backup root:
  ~/agent-hub-backups/repo-retirement/<timestamp>/
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CURRENT_SYSTEM_REPOS = {
    "sun2141/agent-hub": {
        "priority": 0,
        "decision": "keep",
        "reason": "Current source of truth for harness backend, dashboard, directives, and execution tools.",
    },
}

CLEANUP_CANDIDATES = {
    "sun2141/harness-dashboard": {
        "priority": 1,
        "decision": "archive_after_backup",
        "reason": "Dashboard source is now duplicated inside agent-hub/harness/dashboard; standalone repo is legacy.",
    },
    "sun2141/project-hub": {
        "priority": 2,
        "decision": "archive_after_backup",
        "reason": "Old project management UI overlaps with current harness project APIs and dashboard.",
    },
    "sun2141/shared-agents": {
        "priority": 3,
        "decision": "review_then_archive",
        "reason": "No direct local dependency found yet; inspect contents before retiring.",
    },
    "sun2141/grace-ai": {
        "priority": 4,
        "decision": "migrate_references_then_archive",
        "reason": "Still referenced by local Drive sync config/tests; migrate references to sun2141/agent-hub first.",
    },
}

DEFAULT_REPOS = list(CURRENT_SYSTEM_REPOS) + list(CLEANUP_CANDIDATES)

LOCAL_CHECKOUTS = {
    "sun2141/agent-hub": "/Users/sun/agent-hub",
    "sun2141/harness-dashboard": "/Users/sun/harness-dashboard",
    "sun2141/project-hub": "/Users/sun/project-hub",
}

GH_REPO_VIEW_FIELDS = (
    "nameWithOwner,description,isArchived,isPrivate,defaultBranchRef,"
    "pushedAt,updatedAt,url,diskUsage,primaryLanguage,repositoryTopics"
)

GH_ISSUE_FIELDS = (
    "number,title,state,stateReason,author,labels,createdAt,updatedAt,closedAt,url"
)

GH_PR_FIELDS = (
    "number,title,state,isDraft,author,headRefName,baseRefName,"
    "createdAt,updatedAt,closedAt,mergedAt,url"
)


@dataclass
class CommandResult:
    cmd: list[str]
    cwd: str | None
    returncode: int
    stdout: str
    stderr: str


@dataclass
class RepoBackupResult:
    repo: str
    priority: int
    decision: str
    reason: str
    mirror_path: str | None = None
    bundle_path: str | None = None
    bundle_sha256: str | None = None
    default_branch: str | None = None
    default_branch_head: str | None = None
    local_checkout: str | None = None
    local_dirty: bool | None = None
    local_untracked_count: int = 0
    metadata_ok: bool = False
    mirror_ok: bool = False
    bundle_ok: bool = False
    fsck_ok: bool = False
    errors: list[str] | None = None


def run(cmd: list[str], cwd: Path | None = None, check: bool = False) -> CommandResult:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    result = CommandResult(
        cmd=cmd,
        cwd=str(cwd) if cwd else None,
        returncode=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(format_command_error(result))
    return result


def format_command_error(result: CommandResult) -> str:
    cmd = " ".join(result.cmd)
    tail = (result.stderr or result.stdout or "").strip()
    return f"{cmd} failed with exit {result.returncode}: {tail[:1000]}"


def repo_slug(repo: str) -> str:
    return repo.replace("/", "__")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_text(path: Path, content: str) -> None:
    ensure_dir(path.parent)
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def target_info(repo: str) -> dict[str, Any]:
    if repo in CURRENT_SYSTEM_REPOS:
        return CURRENT_SYSTEM_REPOS[repo]
    if repo in CLEANUP_CANDIDATES:
        return CLEANUP_CANDIDATES[repo]
    return {
        "priority": 99,
        "decision": "manual_review",
        "reason": "User-specified repository; not in built-in cleanup list.",
    }


def parse_default_branch(metadata: dict[str, Any]) -> str | None:
    ref = metadata.get("defaultBranchRef")
    if isinstance(ref, dict):
        return ref.get("name")
    return None


def collect_json_command(path: Path, cmd: list[str], cwd: Path | None = None) -> bool:
    result = run(cmd, cwd=cwd)
    payload: Any
    if result.returncode == 0 and result.stdout.strip():
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            payload = {
                "raw_stdout": result.stdout,
                "stderr": result.stderr,
                "returncode": result.returncode,
            }
    else:
        payload = {
            "error": True,
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "cmd": cmd,
        }
    write_json(path, payload)
    return result.returncode == 0


def collect_github_metadata(repo: str, repo_dir: Path) -> tuple[bool, dict[str, Any]]:
    metadata_dir = repo_dir / "github"
    ensure_dir(metadata_dir)

    metadata_result = run(["gh", "repo", "view", repo, "--json", GH_REPO_VIEW_FIELDS])
    metadata_ok = metadata_result.returncode == 0
    metadata: dict[str, Any] = {}
    if metadata_ok:
        metadata = json.loads(metadata_result.stdout)
    else:
        metadata = {
            "error": True,
            "returncode": metadata_result.returncode,
            "stdout": metadata_result.stdout,
            "stderr": metadata_result.stderr,
        }
    write_json(metadata_dir / "repo.json", metadata)

    collect_json_command(
        metadata_dir / "issues.json",
        ["gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", GH_ISSUE_FIELDS],
    )
    collect_json_command(
        metadata_dir / "pull_requests.json",
        ["gh", "pr", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", GH_PR_FIELDS],
    )

    owner, name = repo.split("/", 1)
    api_base = f"repos/{owner}/{name}"
    collect_json_command(metadata_dir / "releases.json", ["gh", "api", f"{api_base}/releases?per_page=100"])
    collect_json_command(metadata_dir / "deployments.json", ["gh", "api", f"{api_base}/deployments?per_page=100"])
    collect_json_command(metadata_dir / "branches.json", ["gh", "api", f"{api_base}/branches?per_page=100"])

    return metadata_ok, metadata


def clone_or_update_mirror(repo: str, mirror_path: Path) -> None:
    if mirror_path.exists():
        result = run(["git", "-C", str(mirror_path), "remote", "update", "--prune"])
        if result.returncode != 0:
            raise RuntimeError(format_command_error(result))
        return

    ensure_dir(mirror_path.parent)
    result = run(["gh", "repo", "clone", repo, str(mirror_path), "--", "--mirror"])
    if result.returncode != 0:
        raise RuntimeError(format_command_error(result))


def backup_git_repo(repo: str, backup_dir: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    slug = repo_slug(repo)
    mirrors_dir = backup_dir / "mirrors"
    bundles_dir = backup_dir / "bundles"
    mirror_path = mirrors_dir / f"{slug}.git"
    bundle_path = bundles_dir / f"{slug}.bundle"
    ensure_dir(bundles_dir)

    clone_or_update_mirror(repo, mirror_path)

    refs_result = run(["git", "-C", str(mirror_path), "show-ref", "--head"])
    write_text(backup_dir / "repos" / slug / "git" / "show-ref.txt", refs_result.stdout + refs_result.stderr)

    fsck_result = run(["git", "-C", str(mirror_path), "fsck", "--full", "--strict"])
    write_text(backup_dir / "repos" / slug / "git" / "fsck.txt", fsck_result.stdout + fsck_result.stderr)

    bundle_result = run(["git", "-C", str(mirror_path), "bundle", "create", str(bundle_path), "--all"])
    if bundle_result.returncode != 0:
        raise RuntimeError(format_command_error(bundle_result))

    verify_result = run(["git", "bundle", "verify", str(bundle_path)])
    write_text(backup_dir / "repos" / slug / "git" / "bundle-verify.txt", verify_result.stdout + verify_result.stderr)
    if verify_result.returncode != 0:
        raise RuntimeError(format_command_error(verify_result))

    default_branch = parse_default_branch(metadata)
    default_head = None
    if default_branch:
        head_result = run(["git", "-C", str(mirror_path), "rev-parse", f"refs/heads/{default_branch}"])
        if head_result.returncode == 0:
            default_head = head_result.stdout.strip()

    return {
        "mirror_path": str(mirror_path),
        "bundle_path": str(bundle_path),
        "bundle_sha256": sha256_file(bundle_path),
        "default_branch": default_branch,
        "default_branch_head": default_head,
        "fsck_ok": fsck_result.returncode == 0,
        "bundle_ok": True,
    }


def copy_untracked_files(local_path: Path, dest_dir: Path) -> int:
    result = run(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=local_path)
    if result.returncode != 0 or not result.stdout:
        return 0
    paths = [p for p in result.stdout.split("\0") if p]
    copied = 0
    for rel in paths:
        src = local_path / rel
        if not src.is_file():
            continue
        if src.stat().st_size > 50 * 1024 * 1024:
            continue
        target = dest_dir / rel
        ensure_dir(target.parent)
        shutil.copy2(src, target)
        copied += 1
    return copied


def snapshot_local_checkout(repo: str, backup_dir: Path) -> dict[str, Any]:
    local = LOCAL_CHECKOUTS.get(repo)
    if not local:
        return {"local_checkout": None, "local_dirty": None, "local_untracked_count": 0}

    local_path = Path(local)
    if not (local_path / ".git").exists():
        return {"local_checkout": str(local_path), "local_dirty": None, "local_untracked_count": 0}

    slug = repo_slug(repo)
    local_dir = backup_dir / "repos" / slug / "local"
    ensure_dir(local_dir)

    commands = {
        "status.txt": ["git", "status", "--short", "--branch"],
        "branch-vv.txt": ["git", "branch", "-vv"],
        "remote-v.txt": ["git", "remote", "-v"],
        "log.txt": ["git", "log", "--oneline", "--decorate", "--max-count=50"],
        "diff.patch": ["git", "diff", "--binary"],
        "diff-cached.patch": ["git", "diff", "--cached", "--binary"],
    }
    status_stdout = ""
    for filename, cmd in commands.items():
        result = run(cmd, cwd=local_path)
        content = result.stdout + result.stderr
        write_text(local_dir / filename, content)
        if filename == "status.txt":
            status_stdout = result.stdout

    untracked_count = copy_untracked_files(local_path, local_dir / "untracked")
    dirty_lines = [
        line
        for line in status_stdout.splitlines()
        if line and not line.startswith("## ")
    ]
    return {
        "local_checkout": str(local_path),
        "local_dirty": bool(dirty_lines),
        "local_untracked_count": untracked_count,
    }


def backup_repo(repo: str, backup_dir: Path) -> RepoBackupResult:
    info = target_info(repo)
    result = RepoBackupResult(
        repo=repo,
        priority=int(info["priority"]),
        decision=str(info["decision"]),
        reason=str(info["reason"]),
        errors=[],
    )
    repo_dir = backup_dir / "repos" / repo_slug(repo)
    ensure_dir(repo_dir)

    try:
        metadata_ok, metadata = collect_github_metadata(repo, repo_dir)
        result.metadata_ok = metadata_ok
        result.default_branch = parse_default_branch(metadata)
    except Exception as exc:  # noqa: BLE001
        result.errors.append(f"metadata: {exc}")
        metadata = {}

    try:
        git_info = backup_git_repo(repo, backup_dir, metadata)
        result.mirror_ok = True
        result.bundle_ok = bool(git_info.get("bundle_ok"))
        result.fsck_ok = bool(git_info.get("fsck_ok"))
        result.mirror_path = git_info.get("mirror_path")
        result.bundle_path = git_info.get("bundle_path")
        result.bundle_sha256 = git_info.get("bundle_sha256")
        result.default_branch = git_info.get("default_branch") or result.default_branch
        result.default_branch_head = git_info.get("default_branch_head")
    except Exception as exc:  # noqa: BLE001
        result.errors.append(f"git: {exc}")

    try:
        local_info = snapshot_local_checkout(repo, backup_dir)
        result.local_checkout = local_info["local_checkout"]
        result.local_dirty = local_info["local_dirty"]
        result.local_untracked_count = int(local_info["local_untracked_count"])
    except Exception as exc:  # noqa: BLE001
        result.errors.append(f"local: {exc}")

    return result


def write_manifest(backup_dir: Path, results: list[RepoBackupResult]) -> None:
    manifest = {
        "version": "1.0",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "backup_dir": str(backup_dir),
        "repos": [asdict(r) for r in sorted(results, key=lambda x: (x.priority, x.repo))],
    }
    write_json(backup_dir / "manifest.json", manifest)


def write_report(backup_dir: Path, results: list[RepoBackupResult]) -> None:
    ordered = sorted(results, key=lambda x: (x.priority, x.repo))
    lines = [
        "# Repository Retirement Backup Report",
        "",
        f"- Backup directory: `{backup_dir}`",
        f"- Created: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Summary",
        "",
        "| Priority | Repository | Decision | Backup | Local dirty | Notes |",
        "|---:|---|---|---|---|---|",
    ]
    for r in ordered:
        backup_ok = r.metadata_ok and r.mirror_ok and r.bundle_ok and r.fsck_ok
        dirty = "n/a" if r.local_dirty is None else ("yes" if r.local_dirty else "no")
        notes = "; ".join(r.errors or []) if r.errors else r.reason
        lines.append(
            f"| {r.priority} | `{r.repo}` | `{r.decision}` | "
            f"{'OK' if backup_ok else 'CHECK'} | {dirty} | {notes} |"
        )

    lines.extend(
        [
            "",
            "## Restore Commands",
            "",
            "Restore a backed-up repository from a bundle:",
            "",
            "```bash",
            "git clone /path/to/<owner>__<repo>.bundle restored-repo",
            "cd restored-repo",
            "git remote add origin https://github.com/<owner>/<repo>.git",
            "```",
            "",
            "Inspect a mirror backup directly:",
            "",
            "```bash",
            "git --git-dir /path/to/<owner>__<repo>.git show-ref --head",
            "git bundle verify /path/to/<owner>__<repo>.bundle",
            "```",
            "",
            "## Cleanup Order",
            "",
            "1. Keep `sun2141/agent-hub` as the current system and verify dashboard/API health.",
            "2. Archive `sun2141/harness-dashboard` after confirming the Vercel project uses `agent-hub/harness/dashboard` as source.",
            "3. Archive `sun2141/project-hub` after confirming no active Vercel alias or workflow points to the old app.",
            "4. Review `sun2141/shared-agents` contents, then archive if no reusable scripts remain.",
            "5. Migrate `sun2141/grace-ai` references in Drive sync config/tests to `sun2141/agent-hub`, then archive.",
            "",
            "Deletion should only happen after an archive period and a successful restore drill from the bundle.",
        ]
    )
    write_text(backup_dir / "REPORT.md", "\n".join(lines) + "\n")


def print_plan(repos: list[str]) -> None:
    print("Repository cleanup priority plan:\n")
    for repo in sorted(repos, key=lambda r: (target_info(r)["priority"], r)):
        info = target_info(repo)
        print(f"{info['priority']:>2}. {repo}")
        print(f"    decision: {info['decision']}")
        print(f"    reason:   {info['reason']}")


def create_backup_dir(root: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = root.expanduser().resolve()
    ensure_dir(backup_root)
    try:
        os.chmod(backup_root, 0o700)
    except OSError:
        pass
    backup_dir = backup_root / stamp
    ensure_dir(backup_dir)
    try:
        os.chmod(backup_dir, 0o700)
    except OSError:
        pass
    return backup_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Back up GitHub repositories before cleanup.")
    parser.add_argument(
        "--repos",
        nargs="+",
        default=DEFAULT_REPOS,
        help="Repositories in owner/name form. Defaults to all related cleanup repositories.",
    )
    parser.add_argument(
        "--root",
        default="~/agent-hub-backups/repo-retirement",
        help="Backup root directory.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the cleanup/backup plan without writing files.",
    )
    args = parser.parse_args(argv)

    repos = list(dict.fromkeys(args.repos))
    if args.dry_run:
        print_plan(repos)
        return 0

    backup_dir = create_backup_dir(Path(args.root))
    print(f"[backup] directory: {backup_dir}")
    results: list[RepoBackupResult] = []
    for repo in sorted(repos, key=lambda r: (target_info(r)["priority"], r)):
        print(f"[backup] {repo}")
        result = backup_repo(repo, backup_dir)
        results.append(result)
        status = "OK" if result.metadata_ok and result.mirror_ok and result.bundle_ok and result.fsck_ok else "CHECK"
        if result.errors:
            print(f"  -> {status}: {'; '.join(result.errors)}")
        else:
            print(f"  -> {status}: bundle={result.bundle_path}")

    write_manifest(backup_dir, results)
    write_report(backup_dir, results)
    print(f"[backup] manifest: {backup_dir / 'manifest.json'}")
    print(f"[backup] report:   {backup_dir / 'REPORT.md'}")

    failed = [
        r.repo for r in results
        if not (r.metadata_ok and r.mirror_ok and r.bundle_ok and r.fsck_ok)
    ]
    if failed:
        print(f"[backup] repositories needing review: {', '.join(failed)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
