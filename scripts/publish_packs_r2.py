#!/usr/bin/env python3
"""Publish the built pack tree to an R2 bucket, uploading only what actually changed.

The bucket layout mirrors the deployed site (packs/<id>/manifest.json, packs/_shared/media/…),
so nothing in the pack build had to change: the app simply resolves the same relative paths
against a different base (see config.js -> packsBase).

Why the S3 API rather than `wrangler r2 object put`: a full pack is ~1,200 objects and wrangler
uploads one object per process invocation. Here a single client uploads in parallel and skips
objects whose content already matches, so the nightly incremental run typically uploads a
handful of files.

Credentials (R2 -> Manage API tokens -> S3 credentials), passed as env vars:
  R2_ACCOUNT_ID          Cloudflare account id (falls back to CLOUDFLARE_ACCOUNT_ID)
  R2_ACCESS_KEY_ID       S3 access key for the bucket
  R2_SECRET_ACCESS_KEY   its secret

Example:
  python scripts/publish_packs_r2.py --dir dist/site/packs --prefix packs --bucket mtc-packs
"""

from __future__ import annotations

import argparse
import hashlib
import mimetypes
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# R2 answers a PutObject with InternalError now and again, and Cloudflare's own guidance is to
# try it again. boto3's retries all happen inside a single call, over a few seconds, so a wobble
# lasting longer than that takes the object out for the whole run — which is how four German VAC
# charts failed a build on 7 Aug 2026 while 437 other objects went up beside them. These passes
# are the outer loop: wait, then re-upload only what failed, with less concurrency each time so a
# struggling endpoint is asked more gently rather than harder.
UPLOAD_RETRY_PASSES = 3
UPLOAD_RETRY_DELAYS_S = (5, 15, 30)

# Pack JSON changes every build and must never be served stale; media and documents are large,
# effectively immutable for a given pack version, and are revalidated by the app's own
# media-manifest, so they can sit in the browser/edge cache for a long time.
CACHE_JSON = "public, max-age=300, must-revalidate"
CACHE_ASSET = "public, max-age=31536000"

EXTRA_TYPES = {
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in EXTRA_TYPES:
        return EXTRA_TYPES[suffix]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def cache_control(key: str) -> str:
    return CACHE_JSON if key.endswith(".json") else CACHE_ASSET


def md5_hex(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - matches S3/R2 single-part ETag, not used for security
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def list_remote(client, bucket: str, prefix: str) -> dict[str, str]:
    """Existing objects under prefix -> ETag (single-part ETags are the MD5 hex)."""
    remote: dict[str, str] = {}
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        for item in response.get("Contents", []):
            remote[item["Key"]] = (item.get("ETag") or "").strip('"')
        if not response.get("IsTruncated"):
            break
        token = response.get("NextContinuationToken")
    return remote


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="Local pack directory (e.g. dist/site/packs)")
    parser.add_argument("--bucket", required=True, help="R2 bucket name")
    parser.add_argument("--prefix", default="packs", help="Key prefix in the bucket, default 'packs'")
    parser.add_argument("--workers", type=int, default=16, help="Parallel uploads, default 16")
    parser.add_argument("--delete", action="store_true",
                        help="Delete remote objects that no longer exist locally (off by default: "
                             "a half-built tree must never wipe a pilot's pack)")
    parser.add_argument("--dry-run", action="store_true", help="Report what would change, upload nothing")
    args = parser.parse_args()

    source = Path(args.dir)
    if not source.is_dir():
        print(f"pack directory not found: {source}", file=sys.stderr)
        sys.exit(1)

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
        config=Config(retries={"max_attempts": 5, "mode": "standard"}, max_pool_connections=args.workers + 4),
    )

    prefix = args.prefix.strip("/")
    local: dict[str, Path] = {}
    for path in sorted(source.rglob("*")):
        if path.is_file():
            relative = path.relative_to(source).as_posix()
            local[f"{prefix}/{relative}" if prefix else relative] = path

    print(f"local objects: {len(local)}", file=sys.stderr)
    remote = list_remote(client, args.bucket, f"{prefix}/" if prefix else "")
    print(f"remote objects: {len(remote)}", file=sys.stderr)

    changed = [(key, path) for key, path in local.items() if remote.get(key) != md5_hex(path)]
    stale = sorted(set(remote) - set(local))
    total_bytes = sum(path.stat().st_size for _, path in changed)
    print(f"to upload: {len(changed)} ({total_bytes / 1e6:.1f} MB); "
          f"unchanged: {len(local) - len(changed)}; stale remote: {len(stale)}", file=sys.stderr)

    if args.dry_run:
        for key, _ in changed[:20]:
            print(f"  would upload {key}", file=sys.stderr)
        return

    def upload(item: tuple[str, Path]) -> str:
        key, path = item
        with path.open("rb") as handle:
            client.put_object(
                Bucket=args.bucket, Key=key, Body=handle,
                ContentType=content_type(path), CacheControl=cache_control(key),
            )
        return key

    def upload_pass(items: list[tuple[str, Path]], workers: int, label: str = "") -> list[tuple[str, Path]]:
        """Upload `items` in parallel; return the ones that did not make it."""
        failed: list[tuple[str, Path]] = []
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(upload, item): item for item in items}
            done = 0
            for future in as_completed(futures):
                item = futures[future]
                try:
                    future.result()
                except Exception as error:  # noqa: BLE001 - collect them; the caller retries
                    failed.append(item)
                    print(f"  {label}failed {item[0]}: {error}", file=sys.stderr)
                done += 1
                if done % 100 == 0 or done == len(items):
                    print(f"  {label}uploaded {done}/{len(items)}", file=sys.stderr)
        return failed

    pending = list(changed)
    if pending:
        pending = upload_pass(pending, args.workers)
        for attempt, delay in enumerate(UPLOAD_RETRY_DELAYS_S[:UPLOAD_RETRY_PASSES], start=1):
            if not pending:
                break
            # Halve the concurrency each pass: whatever the endpoint was struggling with, asking
            # for the same thing just as hard is not the way to find out if it has recovered.
            workers = max(1, args.workers >> attempt)
            print(f"retry {attempt}/{UPLOAD_RETRY_PASSES}: {len(pending)} object(s) in "
                  f"{delay}s at {workers} worker(s)", file=sys.stderr)
            time.sleep(delay)
            pending = upload_pass(pending, workers, label=f"retry {attempt}: ")
    failures = len(pending)

    if stale and args.delete:
        for start in range(0, len(stale), 1000):
            batch = [{"Key": key} for key in stale[start:start + 1000]]
            client.delete_objects(Bucket=args.bucket, Delete={"Objects": batch})
        print(f"deleted {len(stale)} stale objects", file=sys.stderr)
    elif stale:
        print(f"kept {len(stale)} stale objects (pass --delete to remove)", file=sys.stderr)

    if failures:
        # Named, not just counted: which objects are missing decides whether the tree a pilot
        # downloads is stale in a corner or broken in the middle.
        print(f"{failures} upload(s) failed after {UPLOAD_RETRY_PASSES} retries:", file=sys.stderr)
        for key, _ in sorted(pending):
            print(f"  {key}", file=sys.stderr)
        sys.exit(1)
    print("R2 publish complete", file=sys.stderr)


if __name__ == "__main__":
    main()
