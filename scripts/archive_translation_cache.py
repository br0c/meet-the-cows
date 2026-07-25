#!/usr/bin/env python3
"""Archive the DeepL translation cache to a PRIVATE R2 bucket.

Why this exists: the cache is the only record of translations we have already paid DeepL for,
and its lifetime quota cannot be bought back. If a source is ever de-licensed and its entries
pruned from the live cache, this frozen copy is what lets them come back verbatim.

Why a private bucket: the packs bucket is served publicly at data.meetthecows.org, so anything
written there is downloadable by anyone. The archive deliberately contains the FULL cache —
including text from sources that are no longer redistributed — so it must live in a bucket with
no public custom domain (the Worker's mtc-data, whose only public route is GET /originals/…).

Credentials (env):
  R2_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
The S3 token must be scoped to include the archive bucket, not only the packs bucket.

Example:
  python scripts/archive_translation_cache.py --bucket mtc-data
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="data/translation-cache.json", help="Cache file to archive")
    parser.add_argument("--bucket", default=os.environ.get("R2_ARCHIVE_BUCKET", "mtc-data"),
                        help="PRIVATE R2 bucket (must not have a public custom domain)")
    parser.add_argument("--prefix", default="archive", help="Key prefix, default 'archive'")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be uploaded, upload nothing")
    args = parser.parse_args()

    source = Path(args.file)
    if not source.is_file():
        print(f"cache file not found: {source}", file=sys.stderr)
        sys.exit(1)

    raw = source.read_bytes()
    try:
        cache = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"cache file is not valid JSON: {error}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(cache, dict) or not cache:
        print("cache file is empty or not an object — refusing to archive it over a good copy", file=sys.stderr)
        sys.exit(1)

    digest = hashlib.sha256(raw).hexdigest()
    stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d")
    dated_key = f"{args.prefix}/translation-cache-{stamp}.json"
    latest_key = f"{args.prefix}/translation-cache-latest.json"

    print(f"entries: {len(cache):,}", file=sys.stderr)
    print(f"bytes:   {len(raw):,}", file=sys.stderr)
    print(f"sha256:  {digest}", file=sys.stderr)
    print(f"keys:    s3://{args.bucket}/{dated_key}", file=sys.stderr)
    print(f"         s3://{args.bucket}/{latest_key}", file=sys.stderr)

    if args.dry_run:
        print("dry run — nothing uploaded", file=sys.stderr)
        return

    account = os.environ.get("R2_ACCOUNT_ID") or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    key_id = os.environ.get("R2_ACCESS_KEY_ID", "")
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    if not (account and key_id and secret):
        print("missing R2 credentials (R2_ACCOUNT_ID/CLOUDFLARE_ACCOUNT_ID, "
              "R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)", file=sys.stderr)
        sys.exit(2)

    try:
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore
    except ModuleNotFoundError:
        print("boto3 is required: python -m pip install boto3", file=sys.stderr)
        sys.exit(2)

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name="auto",
        config=Config(retries={"max_attempts": 5, "mode": "standard"}),
    )

    # The dated key is the immutable record; latest is the convenient restore point. No
    # Cache-Control and no public domain on this bucket, so neither is reachable from the web.
    for key in (dated_key, latest_key):
        client.put_object(
            Bucket=args.bucket, Key=key, Body=raw,
            ContentType="application/json; charset=utf-8",
            Metadata={"entries": str(len(cache)), "sha256": digest},
        )
        print(f"uploaded {key}", file=sys.stderr)

    head = client.head_object(Bucket=args.bucket, Key=latest_key)
    print(f"verified {latest_key}: {head['ContentLength']:,} bytes", file=sys.stderr)
    print("archive complete", file=sys.stderr)


if __name__ == "__main__":
    main()
