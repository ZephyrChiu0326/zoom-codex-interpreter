#!/usr/bin/env python3
"""Build shareable ZIP archives for Zoom Codex Interpreter."""

from __future__ import annotations

import json
import os
import stat
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
DIST = ROOT / "dist"
MANIFEST = EXTENSION / "manifest.json"

EXCLUDED_DIRS = {".git", "dist", "__pycache__"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".crx", ".pem", ".log"}
EXCLUDED_NAMES = {".DS_Store"}


def version() -> str:
    return str(json.loads(MANIFEST.read_text(encoding="utf-8"))["version"])


def should_exclude(path: Path) -> bool:
    if path.name in EXCLUDED_NAMES:
        return True
    if path.suffix in EXCLUDED_SUFFIXES:
        return True
    return any(part in EXCLUDED_DIRS for part in path.parts)


def add_file(archive: zipfile.ZipFile, source: Path, arcname: str) -> None:
    info = zipfile.ZipInfo.from_file(source, arcname)
    mode = source.stat().st_mode
    info.external_attr = (mode & 0xFFFF) << 16
    with source.open("rb") as handle:
        archive.writestr(info, handle.read(), compress_type=zipfile.ZIP_DEFLATED)


def build_zip(target: Path, base: Path, *, extension_only: bool) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if extension_only:
            for path in sorted(EXTENSION.rglob("*")):
                if path.is_file() and not should_exclude(path.relative_to(EXTENSION)):
                    add_file(archive, path, str(path.relative_to(EXTENSION)))
            return

        for path in sorted(ROOT.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(ROOT)
            if should_exclude(relative):
                continue
            add_file(archive, path, str(relative))


def write_update_manifest(v: str) -> None:
    template_path = ROOT / "updates" / "update.json"
    try:
        data = json.loads(template_path.read_text(encoding="utf-8"))
    except Exception:
        data = {"name": "Zoom Codex Interpreter"}
    data.update(
        {
            "version": v,
            "releaseDate": date.today().isoformat(),
            "extensionDownload": f"ZoomCodexInterpreter-extension-v{v}.zip",
            "fullDownload": f"ZoomCodexInterpreter-full-v{v}.zip",
        }
    )
    path = DIST / "update.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_share_readme(v: str) -> None:
    path = DIST / "README-SHARE.txt"
    path.write_text(
        "\n".join(
            [
                "Zoom Codex Interpreter share files",
                "",
                f"Version: {v}",
                "",
                "For normal users:",
                f"  ZoomCodexInterpreter-extension-v{v}.zip",
                "  Unzip it, then load that folder from chrome://extensions -> Load unpacked.",
                "",
                "For collaborators:",
                f"  ZoomCodexInterpreter-full-v{v}.zip",
                "  Complete project, including server.py and release scripts.",
                "",
                f"Git history bundle:",
                f"  ZoomCodexInterpreter-v{v}.bundle",
                "  Clone with:",
                f"    git clone ZoomCodexInterpreter-v{v}.bundle zoom-codex-interpreter",
                "",
                "The local translation server must be running on 127.0.0.1:8765.",
                "See README.md for setup instructions.",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> int:
    v = version()
    DIST.mkdir(exist_ok=True)
    extension_zip = DIST / f"ZoomCodexInterpreter-extension-v{v}.zip"
    full_zip = DIST / f"ZoomCodexInterpreter-full-v{v}.zip"
    build_zip(extension_zip, EXTENSION, extension_only=True)
    build_zip(full_zip, ROOT, extension_only=False)
    write_update_manifest(v)
    write_share_readme(v)
    print(extension_zip)
    print(full_zip)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
