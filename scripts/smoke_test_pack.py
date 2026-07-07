#!/usr/bin/env python3
"""Smoke-test a generated Meet the Cows offline data pack.

Default pack path:
  data/packs/fr-alps

Usage:
  python scripts/smoke_test_pack.py
  python scripts/smoke_test_pack.py data/packs/fr-alps
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise SystemExit(f"ERROR: could not read JSON {path}: {exc}") from exc


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a Meet the Cows generated pack.")
    parser.add_argument(
        "pack_dir",
        nargs="?",
        default="data/packs/fr-alps",
        help="Pack directory to test, default: data/packs/fr-alps",
    )
    parser.add_argument(
        "--max-missing-media",
        type=int,
        default=0,
        help="Allowed missing media/docs references before failing. Default: 0",
    )
    args = parser.parse_args()

    pack_dir = Path(args.pack_dir)
    manifest_path = pack_dir / "manifest.json"
    fields_path = pack_dir / "fields.json"

    errors: list[str] = []
    warnings: list[str] = []

    if not pack_dir.exists():
        errors.append(f"pack directory does not exist: {pack_dir}")
    if not manifest_path.exists():
        errors.append(f"missing manifest.json: {manifest_path}")
    if not fields_path.exists():
        errors.append(f"missing fields.json: {fields_path}")

    if errors:
        for err in errors:
            print(f"ERROR: {err}", file=sys.stderr)
        return 1

    manifest = load_json(manifest_path)
    fields = load_json(fields_path)

    if not isinstance(manifest, dict):
        errors.append("manifest.json is not an object")
        manifest = {}
    if not isinstance(fields, list):
        errors.append("fields.json is not a list")
        fields = []

    pack_id = manifest.get("id")
    if not pack_id:
        warnings.append("manifest.id missing")
    elif pack_id != pack_dir.name:
        warnings.append(f"manifest.id ({pack_id}) differs from directory name ({pack_dir.name})")

    fields_url = manifest.get("fieldsUrl")
    if fields_url and fields_url not in {"fields.json", "./fields.json"}:
        warnings.append(f"manifest.fieldsUrl is unusual: {fields_url!r}")

    required_field_keys = ["id", "name", "latitude", "longitude"]
    seen_ids: set[str] = set()
    missing_media = 0
    media_count = 0
    pdf_count = 0
    image_count = 0

    for i, field in enumerate(fields):
        if not isinstance(field, dict):
            errors.append(f"field #{i} is not an object")
            continue

        for key in required_field_keys:
            if key not in field:
                errors.append(f"field #{i} missing {key}")

        field_id = str(field.get("id", "")).strip()
        if field_id:
            if field_id in seen_ids:
                errors.append(f"duplicate field id: {field_id}")
            seen_ids.add(field_id)

        lat = field.get("latitude")
        lon = field.get("longitude")
        if not isinstance(lat, (int, float)) or not (-90 <= float(lat) <= 90):
            errors.append(f"field {field_id or i} invalid latitude: {lat!r}")
        if not isinstance(lon, (int, float)) or not (-180 <= float(lon) <= 180):
            errors.append(f"field {field_id or i} invalid longitude: {lon!r}")

        for media in as_list(field.get("media")):
            if not isinstance(media, dict):
                errors.append(f"field {field_id or i} has non-object media entry")
                continue
            url = str(media.get("url", "")).strip()
            media_type = str(media.get("type", "")).strip().lower()
            if not url:
                errors.append(f"field {field_id or i} has media entry without url")
                continue

            if url.startswith(("http://", "https://", "data:")):
                warnings.append(f"field {field_id or i} has non-local media URL: {url[:120]}")
                continue

            media_count += 1
            if media_type == "pdf" or url.lower().endswith(".pdf"):
                pdf_count += 1
            else:
                image_count += 1

            media_path = (pack_dir / url).resolve()
            try:
                media_path.relative_to(pack_dir.resolve())
            except ValueError:
                errors.append(f"field {field_id or i} media escapes pack dir: {url}")
                continue

            if not media_path.exists():
                missing_media += 1
                if missing_media <= 20:
                    warnings.append(f"missing media/doc file: {url}")

    if not fields:
        errors.append("fields.json contains no fields")

    # The in-app update mechanism depends on these two files: media-manifest.json drives the
    # incremental media sync, state.json drives the build short-circuit. A pack missing either
    # silently degrades (full re-downloads / rebuilds every run), so fail the deploy instead.
    media_manifest_path = pack_dir / "media-manifest.json"
    if not media_manifest_path.exists():
        errors.append(f"missing media-manifest.json: {media_manifest_path}")
    else:
        media_manifest = load_json(media_manifest_path)
        if not isinstance(media_manifest, dict) or not isinstance(media_manifest.get("files"), dict):
            errors.append("media-manifest.json is not an object with a files map")
        elif media_manifest.get("version") != manifest.get("version"):
            errors.append(
                f"media-manifest version ({media_manifest.get('version')}) differs from "
                f"manifest version ({manifest.get('version')})"
            )
        elif media_count and not media_manifest["files"]:
            errors.append("media-manifest.json lists no files although fields reference media")
    if not (pack_dir / "state.json").exists():
        errors.append(f"missing state.json: {pack_dir / 'state.json'}")

    print("Pack smoke test")
    print(f"  Pack dir:     {pack_dir}")
    print(f"  Pack id:      {manifest.get('id', '—')}")
    print(f"  Name:         {manifest.get('name', '—')}")
    print(f"  Version:      {manifest.get('version', '—')}")
    print(f"  Fields:       {len(fields)}")
    print(f"  Media refs:   {media_count} ({image_count} images, {pdf_count} PDFs/docs)")
    print(f"  Missing refs: {missing_media}")

    if warnings:
        print("\nWarnings:")
        for warning in warnings[:80]:
            print(f"  WARN: {warning}")
        if len(warnings) > 80:
            print(f"  WARN: ... {len(warnings) - 80} more")

    if missing_media > args.max_missing_media:
        errors.append(
            f"missing media/doc references ({missing_media}) exceeds allowed "
            f"({args.max_missing_media})"
        )

    if errors:
        print("\nErrors:", file=sys.stderr)
        for err in errors[:80]:
            print(f"  ERROR: {err}", file=sys.stderr)
        if len(errors) > 80:
            print(f"  ERROR: ... {len(errors) - 80} more", file=sys.stderr)
        return 1

    print("\nOK: pack looks valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
