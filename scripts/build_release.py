#!/usr/bin/env python3
"""Build shareable Chrome and Edge ZIP archives for Zoom Codex Interpreter."""

from __future__ import annotations

import json
import shutil
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
    info.external_attr = (source.stat().st_mode & 0xFFFF) << 16
    archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


def add_bytes(archive: zipfile.ZipFile, data: bytes, arcname: str) -> None:
    info = zipfile.ZipInfo(arcname)
    info.external_attr = 0o644 << 16
    archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)


def browser_manifest(browser: str) -> bytes:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if browser == "edge":
        data["name"] = "Zoom Codex Interpreter for Edge"
        data["description"] = (
            "Translate Zoom web live captions in near real time in Microsoft Edge "
            "using the local Codex model proxy."
        )
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def build_extension_zip(target: Path, browser: str) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(EXTENSION.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(EXTENSION)
            if should_exclude(relative):
                continue
            if relative == Path("manifest.json"):
                add_bytes(archive, browser_manifest(browser), "manifest.json")
            else:
                add_file(archive, path, str(relative))


def build_full_zip(target: Path) -> None:
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
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
            "chromeDownload": f"ZoomCodexInterpreter-chrome-v{v}.zip",
            "edgeDownload": f"ZoomCodexInterpreter-edge-v{v}.zip",
            "fullDownload": f"ZoomCodexInterpreter-full-v{v}.zip",
        }
    )
    (DIST / "update.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_share_readme(v: str) -> None:
    (DIST / "README-SHARE.txt").write_text(
        "\n".join(
            [
                "Zoom Codex Interpreter share files",
                "",
                f"Version: {v}",
                "",
                "Google Chrome:",
                f"  ZoomCodexInterpreter-chrome-v{v}.zip",
                "  Unzip, then load that folder from chrome://extensions -> Load unpacked.",
                "",
                "Microsoft Edge:",
                f"  ZoomCodexInterpreter-edge-v{v}.zip",
                "  Unzip, then load that folder from edge://extensions -> Load unpacked.",
                "",
                "Compatibility alias:",
                f"  ZoomCodexInterpreter-extension-v{v}.zip (same as the Chrome build)",
                "",
                "For collaborators:",
                f"  ZoomCodexInterpreter-full-v{v}.zip",
                "  Complete project, including server.py and release scripts.",
                "",
                "Git history bundle:",
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
    chrome_zip = DIST / f"ZoomCodexInterpreter-chrome-v{v}.zip"
    edge_zip = DIST / f"ZoomCodexInterpreter-edge-v{v}.zip"
    alias_zip = DIST / f"ZoomCodexInterpreter-extension-v{v}.zip"
    full_zip = DIST / f"ZoomCodexInterpreter-full-v{v}.zip"
    build_extension_zip(chrome_zip, "chrome")
    build_extension_zip(edge_zip, "edge")
    shutil.copyfile(chrome_zip, alias_zip)
    build_full_zip(full_zip)
    write_update_manifest(v)
    write_share_readme(v)
    for path in (chrome_zip, edge_zip, alias_zip, full_zip):
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
