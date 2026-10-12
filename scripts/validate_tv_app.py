#!/usr/bin/env python3
"""Check the reusable Android TV project contract without third-party packages."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


REQUIRED_MANIFEST = {
    "displayName",
    "applicationId",
    "versionName",
    "versionCode",
    "minSdk",
    "abis",
}
REQUIRED_DIRS = ("android", "core", "scripts", "tests", ".github/workflows")
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(github|release|signing)[_-]?token\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{20,}"),
)


def issue(code: str, message: str, issues: list[dict[str, str]]) -> None:
    issues.append({"code": code, "message": message})


def load_manifest(root: Path, issues: list[dict[str, str]]) -> dict:
    candidates = [root / "app.json", root / "config" / "app.json"]
    path = next((item for item in candidates if item.is_file()), None)
    if path is None:
        gradle = root / "android" / "app" / "build.gradle"
        if gradle.is_file():
            text = gradle.read_text(encoding="utf-8", errors="replace")
            def capture(pattern: str, default: object = None) -> object:
                match = re.search(pattern, text)
                return match.group(1) if match else default
            application_id = capture(r"applicationId\s+['\"]([^'\"]+)['\"]")
            version_name = capture(r"versionName\s+([A-Za-z0-9_.\"-]+)")
            if version_name == "appVersion":
                version_name = capture(r"def\s+appVersion\s*=\s*['\"]([^'\"]+)['\"]")
            version_name = str(version_name).strip('"') if version_name is not None else None
            version_code = capture(r"versionCode\s+(\d+)")
            min_sdk = capture(r"minSdk\s+(\d+)")
            abis = re.findall(r'abiFilters\s+(.+)', text)
            abi_list = re.findall(r'["\']([^"\']+)["\']', abis[0]) if abis else []
            data = {
                "displayName": "(from Android resources)",
                "applicationId": application_id,
                "versionName": version_name,
                "versionCode": int(version_code) if version_code else None,
                "minSdk": int(min_sdk) if min_sdk else None,
                "abis": abi_list,
            }
            missing = sorted(key for key in REQUIRED_MANIFEST if not data.get(key) and key != "displayName")
            if missing:
                issue("manifest.fields", "Gradle metadata is missing: " + ", ".join(missing), issues)
            return data
        issue("manifest.missing", "app.json, config/app.json, or android/app/build.gradle is required", issues)
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        issue("manifest.invalid", f"cannot read {path}: {exc}", issues)
        return {}
    missing = sorted(REQUIRED_MANIFEST - set(data))
    if missing:
        issue("manifest.fields", "missing fields: " + ", ".join(missing), issues)
    if data.get("minSdk") != 23:
        issue("manifest.min_sdk", "minSdk should be 23 unless the project explicitly documents another baseline", issues)
    if not isinstance(data.get("abis"), list) or not data.get("abis"):
        issue("manifest.abis", "abis must be a non-empty list", issues)
    return data


def scan_files(root: Path, issues: list[dict[str, str]]) -> None:
    ignored = {".git", "build", ".gradle", "backups", "node_modules"}
    for path in root.rglob("*"):
        if not path.is_file() or any(part in ignored for part in path.parts):
            continue
        if path.stat().st_size > 2_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for pattern in SECRET_PATTERNS:
            if pattern.search(text):
                issue("secret.detected", f"possible signing key or token in {path.relative_to(root)}", issues)
                break


def validate(root: Path) -> dict:
    issues: list[dict[str, str]] = []
    manifest = load_manifest(root, issues)
    for relative in REQUIRED_DIRS:
        if not (root / relative).exists():
            issue("path.missing", f"required project path is missing: {relative}", issues)
    ui_candidates = [root / "ui"] + list((root / "core" / "cmd").glob("*/ui")) if (root / "core" / "cmd").is_dir() else [root / "ui"]
    if not any(path.is_dir() for path in ui_candidates):
        issue("path.missing", "a WebView UI directory is required at ui/ or core/cmd/*/ui/", issues)
    workflows = list((root / ".github" / "workflows").glob("*.y*ml")) if (root / ".github" / "workflows").is_dir() else []
    if not workflows:
        issue("workflow.missing", "at least one GitHub Actions workflow is required", issues)
    else:
        workflow_text = "\n".join(path.read_text(encoding="utf-8", errors="replace") for path in workflows)
        for needle, code in (("assemble", "workflow.android"), ("go test", "workflow.go"), ("SHA256", "workflow.hash")):
            if needle.lower() not in workflow_text.lower():
                issue(code, f"workflows do not mention {needle}", issues)
    scan_files(root, issues)
    return {"ok": not issues, "root": str(root), "manifest": manifest, "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    result = validate(Path(args.root).resolve())
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("TV project contract: " + ("PASS" if result["ok"] else "FAIL"))
        for item in result["issues"]:
            print(f"- {item['code']}: {item['message']}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
