#!/usr/bin/env python3
"""Offline tests for how the R2 publish survives a wobbling endpoint.

Run directly: `python scripts/test_publish_retry.py`. No network, no credentials; boto3 is
stubbed with a fake client.

Written after the 7 Aug 2026 build failed publishing four German VAC charts. 437 objects went up
beside them; the four came back InternalError, which is Cloudflare's "try again". boto3's own
retries all happen inside one put_object call over a few seconds, so a wobble that outlasts that
took the object out for the whole run and the build with it.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class FakeClient:
    """An R2 that fails the named keys for their first `fail_times` attempts."""

    def __init__(self, flaky: dict[str, int], remote: dict[str, str] | None = None):
        self.flaky = dict(flaky)
        self.remote = remote or {}
        self.attempts: dict[str, int] = {}
        self.stored: dict[str, bytes] = {}

    def list_objects_v2(self, **kwargs):
        return {"Contents": [{"Key": k, "ETag": f'"{v}"'} for k, v in self.remote.items()],
                "IsTruncated": False}

    def put_object(self, Bucket=None, Key=None, Body=None, **kwargs):  # noqa: N803 - boto3 spelling
        self.attempts[Key] = self.attempts.get(Key, 0) + 1
        if self.flaky.get(Key, 0) >= self.attempts[Key]:
            raise RuntimeError(
                "An error occurred (InternalError) when calling the PutObject operation "
                "(reached max retries: 5): We encountered an internal error. Please try again.")
        self.stored[Key] = Body.read()
        return {}

    def delete_objects(self, **kwargs):
        return {}


def load_publisher(client: FakeClient):
    """Import publish_packs_r2 with boto3 and sleep stubbed out."""
    fake_boto3 = types.ModuleType("boto3")
    fake_boto3.client = lambda *a, **k: client  # type: ignore[attr-defined]
    fake_botocore = types.ModuleType("botocore")
    fake_config_mod = types.ModuleType("botocore.config")
    fake_config_mod.Config = lambda **k: None  # type: ignore[attr-defined]
    sys.modules["boto3"] = fake_boto3
    sys.modules["botocore"] = fake_botocore
    sys.modules["botocore.config"] = fake_config_mod

    spec = importlib.util.spec_from_file_location(
        "publish_packs_r2", ROOT / "scripts" / "publish_packs_r2.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Guarded rather than assumed: a version of the script with no retry loop imports no `time`,
    # and the tests must then fail on the behaviour that is missing, not on this line.
    if hasattr(module, "time"):
        module.time.sleep = lambda s: None      # no real waiting in tests
    return module


def build_tree(tmp: Path, names: list[str]) -> Path:
    packs = tmp / "packs"
    (packs / "_shared" / "docs" / "vac").mkdir(parents=True)
    for name in names:
        (packs / "_shared" / "docs" / "vac" / name).write_bytes(name.encode() * 32)
    return packs


def run(module, source: Path, client: FakeClient) -> int:
    """Run main() with argv set; return the exit code (0 when it does not call sys.exit)."""
    argv = sys.argv
    sys.argv = ["publish_packs_r2.py", "--dir", str(source), "--bucket", "b",
                "--prefix", "packs", "--workers", "4"]
    os_environ_backup = dict(module.os.environ)
    module.os.environ.update({"R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "k",
                              "R2_SECRET_ACCESS_KEY": "s"})
    try:
        module.main()
        return 0
    except SystemExit as exit_error:
        return int(exit_error.code or 0)
    finally:
        sys.argv = argv
        module.os.environ.clear()
        module.os.environ.update(os_environ_backup)


def test_a_transient_internal_error_is_retried_and_succeeds(tmp_path: Path):
    """The 7 Aug case: four charts fail the first pass and go up on the second."""
    names = ["EDKM.pdf", "EDBI.pdf", "EDHS.pdf", "EDMB.pdf", "LFNC.pdf"]
    source = build_tree(tmp_path, names)
    flaky = {f"packs/_shared/docs/vac/{n}": 1 for n in names[:4]}
    client = FakeClient(flaky)
    module = load_publisher(client)

    code = run(module, source, client)
    assert code == 0, f"publish should have recovered, exited {code}"
    for name in names:
        key = f"packs/_shared/docs/vac/{name}"
        assert key in client.stored, f"{key} never landed"
    assert client.attempts["packs/_shared/docs/vac/EDKM.pdf"] == 2, client.attempts


def test_a_persistent_failure_still_fails_the_publish(tmp_path: Path):
    """Retrying is not the same as pretending. An object that never lands is still a red build."""
    source = build_tree(tmp_path, ["EDKM.pdf", "LFNC.pdf"])
    client = FakeClient({"packs/_shared/docs/vac/EDKM.pdf": 99})
    module = load_publisher(client)

    code = run(module, source, client)
    assert code == 1, f"a permanently failing object must fail the publish, exited {code}"
    assert "packs/_shared/docs/vac/LFNC.pdf" in client.stored, "the healthy object should still go up"


def test_retries_stop_once_everything_has_landed(tmp_path: Path):
    """A clean first pass must not sit through the retry delays."""
    source = build_tree(tmp_path, ["A.pdf", "B.pdf"])
    client = FakeClient({})
    module = load_publisher(client)

    code = run(module, source, client)
    assert code == 0, code
    assert all(n == 1 for n in client.attempts.values()), client.attempts


def test_unchanged_objects_are_not_reuploaded(tmp_path: Path):
    """The incremental behaviour the nightly run depends on must survive the restructure."""
    source = build_tree(tmp_path, ["A.pdf", "B.pdf"])
    import hashlib
    same = hashlib.md5((source / "_shared" / "docs" / "vac" / "A.pdf").read_bytes()).hexdigest()  # noqa: S324
    client = FakeClient({}, remote={"packs/_shared/docs/vac/A.pdf": same})
    module = load_publisher(client)

    code = run(module, source, client)
    assert code == 0, code
    assert "packs/_shared/docs/vac/A.pdf" not in client.attempts, "unchanged object was re-uploaded"
    assert "packs/_shared/docs/vac/B.pdf" in client.stored


def main() -> None:
    import tempfile
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for test in tests:
        with tempfile.TemporaryDirectory() as tmp:
            test(Path(tmp))
        print(f"  ok  {test.__name__}")
    print(f"\nAll {len(tests)} publish retry tests passed")


if __name__ == "__main__":
    main()
