#!/usr/bin/env python3
"""Offline tests for how source fetches survive a rate-limited upstream.

Run directly: `python scripts/test_source_fetch_retry.py`. No network; urlopen is monkeypatched.

Written after the 4 Aug 2026 data-pack build died on an OpenAIP HTTP 429. Nothing in the repo
had changed — the same commit had built four mornings running. What turned one refused request
into a dead build was that cached_http_get re-raised everything except a 304, so a rate limit
refused the cached copy sitting right beside it, and the OpenAIP country fetch then made an
unguarded second request that was certain to be refused for the same reason.
"""

from __future__ import annotations

import importlib.util
import io
import json
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_build_pack():
    spec = importlib.util.spec_from_file_location("build_pack", ROOT / "scripts" / "build_pack.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bp = load_build_pack()


class FakeResponse(io.BytesIO):
    """Just enough of an http.client.HTTPResponse for _read_response."""

    def __init__(self, body: bytes, headers: dict[str, str] | None = None):
        super().__init__(body)
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def rate_limited(retry_after: str | None = None) -> urllib.error.HTTPError:
    import email.message
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError("http://x/y", 429, "Too Many Requests", headers, None)


def patch(monkey: dict, tmp: Path):
    """Swap urlopen and sleep; returns a list that records the delays slept."""
    slept: list[float] = []
    bp.urllib.request.urlopen = monkey["urlopen"]
    bp.time.sleep = lambda s: slept.append(s)
    return slept


def restore(real_urlopen, real_sleep):
    bp.urllib.request.urlopen = real_urlopen
    bp.time.sleep = real_sleep


REAL_URLOPEN = bp.urllib.request.urlopen
REAL_SLEEP = bp.time.sleep


def test_a_rate_limit_is_retried_and_then_succeeds(tmp_path: Path):
    """One 429 must not be the end of it: back off and ask again."""
    calls = {"n": 0}

    def urlopen(request, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise rate_limited("2")
        return FakeResponse(b'{"ok": true}', {"ETag": "abc"})

    slept = patch({"urlopen": urlopen}, tmp_path)
    try:
        data = bp.cached_http_get("http://x/y", tmp_path / "c.json", ttl_s=0)
    finally:
        restore(REAL_URLOPEN, REAL_SLEEP)
    assert json.loads(data) == {"ok": True}, data
    assert calls["n"] == 2, calls
    assert slept == [2.0], f"Retry-After should be honoured, slept {slept}"


def test_retry_after_is_honoured_over_backoff(tmp_path: Path):
    """A server that names its delay is believed, up to a sane ceiling."""
    def urlopen(request, timeout=None):
        raise rate_limited("5")

    slept = patch({"urlopen": urlopen}, tmp_path)
    try:
        try:
            bp.cached_http_get("http://x/y", tmp_path / "none.json", ttl_s=0)
        except urllib.error.HTTPError:
            pass
    finally:
        restore(REAL_URLOPEN, REAL_SLEEP)
    assert slept == [5.0, 5.0, 5.0], slept


def test_a_rate_limit_falls_back_to_the_cached_copy(tmp_path: Path):
    """The bug: yesterday's good bytes were on disk and a 429 refused to use them.

    CI restores the source cache between runs and sets the TTL to 0, so every build revalidates
    with a conditional GET. A rate-limited revalidation has to degrade the way a 304 does.
    """
    cache = tmp_path / "openaip_airports_FR_1.json"
    cache.write_bytes(b'{"items": [{"name": "Saint-Crepin"}]}')
    bp._cache_meta_path(cache).write_text(json.dumps({"fetched_at": bp.time.time() - 3600}))

    def urlopen(request, timeout=None):
        raise rate_limited()

    patch({"urlopen": urlopen}, tmp_path)
    try:
        data = bp.cached_http_get("http://x/openaip", cache, ttl_s=0)
    finally:
        restore(REAL_URLOPEN, REAL_SLEEP)
    assert json.loads(data)["items"][0]["name"] == "Saint-Crepin", data


def test_a_rate_limit_with_no_cache_still_raises(tmp_path: Path):
    """Stale beats nothing; nothing does not beat a red build. No cache means the error stands."""
    def urlopen(request, timeout=None):
        raise rate_limited()

    patch({"urlopen": urlopen}, tmp_path)
    try:
        raised = False
        try:
            bp.cached_http_get("http://x/y", tmp_path / "absent.json", ttl_s=0)
        except urllib.error.HTTPError as error:
            raised = error.code == 429
    finally:
        restore(REAL_URLOPEN, REAL_SLEEP)
    assert raised, "a 429 with nothing cached must not be swallowed"


def test_a_404_is_not_retried(tmp_path: Path):
    """'No' is not 'not now'. Retrying a 404 only spends the build's time."""
    calls = {"n": 0}

    def urlopen(request, timeout=None):
        calls["n"] += 1
        import email.message
        raise urllib.error.HTTPError("http://x/y", 404, "Not Found", email.message.Message(), None)

    slept = patch({"urlopen": urlopen}, tmp_path)
    try:
        try:
            bp.cached_http_get("http://x/y", tmp_path / "n.json", ttl_s=0)
        except urllib.error.HTTPError as error:
            assert error.code == 404
    finally:
        restore(REAL_URLOPEN, REAL_SLEEP)
    assert calls["n"] == 1, f"a 404 was retried {calls['n']} times"
    assert slept == [], slept


def test_a_304_still_reuses_the_cache(tmp_path: Path):
    """The path that already worked must keep working."""
    cache = tmp_path / "c.json"
    cache.write_bytes(b'{"cached": true}')
    bp._cache_meta_path(cache).write_text(json.dumps({"etag": "abc", "fetched_at": 0}))

    def urlopen(request, timeout=None):
        import email.message
        raise urllib.error.HTTPError("http://x/y", 304, "Not Modified", email.message.Message(), None)

    slept = patch({"urlopen": urlopen}, tmp_path)
    try:
        data = bp.cached_http_get("http://x/y", cache, ttl_s=0)
    finally:
        restore(REAL_URLOPEN, REAL_SLEEP)
    assert json.loads(data) == {"cached": True}, data
    assert slept == [], "a 304 is an answer, not a retry"


def main() -> None:
    import tempfile
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for test in tests:
        with tempfile.TemporaryDirectory() as tmp:
            test(Path(tmp))
        print(f"  ok  {test.__name__}")
    print(f"\nAll {len(tests)} source-fetch retry tests passed")


if __name__ == "__main__":
    main()
