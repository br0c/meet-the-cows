from __future__ import annotations

import hashlib
import mimetypes
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

try:
    from PIL import Image
except Exception:
    Image = None


BASE_URL = "https://landout.streckenflug.at"
IMAGE_DIR = Path(".cache/fr-alps/images/streckenflug")


def streckenflug_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json,text/javascript,*/*;q=0.01",
            "X-Requested-With": "XMLHttpRequest",
        }
    )
    return session


def streckenflug_detail_url(field_id: str) -> str:
    return f"{BASE_URL}/json.php?{urlencode({'inc': 'map', 'task': 'landeplatz', 'id': str(field_id)})}"


def fetch_streckenflug_detail(
    field_id: str,
    *,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """
    Fetch the JSON detail payload used by the Landout/Streckenflug map sidebar.

    This is the endpoint called by the page JavaScript:

        ./json.php?inc=map&task=landeplatz&id=<field_id>

    It contains the useful full detail fields, photo HTML snippets and feedback.
    """
    s = session or streckenflug_session()
    field_id = str(field_id)

    response = s.get(
        streckenflug_detail_url(field_id),
        timeout=30,
        headers={"Referer": f"{BASE_URL}/index.php?inc=map&iID={field_id}"},
    )
    response.raise_for_status()
    return response.json()


def _normalise_streckenflug_url(url: str) -> str:
    url = url.replace("\\/", "/").replace("&amp;", "&")

    if url.startswith("//"):
        return "https:" + url

    if url.startswith("/"):
        return BASE_URL + url

    if not url.startswith("http"):
        return BASE_URL + "/" + url.lstrip("/")

    return url


def extract_streckenflug_image_urls(detail: dict[str, Any]) -> list[str]:
    """
    Extract full-resolution shield.php image URLs from the JSON detail payload.

    We deliberately avoid BeautifulSoup. The HTML snippets are small and stable.
    Prefer photoswipe href/data-src URLs because img src often points to thumbs.
    """
    html = "\n".join(str(detail.get(key) or "") for key in ("fotos", "feedback"))

    urls: list[str] = []

    for match in re.findall(
        r'(?:data-src|href)=["\']([^"\']*shield\.php\?[^"\']+)["\']',
        html,
        flags=re.I,
    ):
        url = _normalise_streckenflug_url(match)

        if url not in urls:
            urls.append(url)

    return urls


def _safe_ext(content_type: str | None, fallback: str = ".jpg") -> str:
    if not content_type:
        return fallback

    content_type = content_type.split(";", 1)[0].strip().lower()
    ext = mimetypes.guess_extension(content_type)

    if ext == ".jpe":
        ext = ".jpg"

    return ext or fallback


def _image_dimensions(path: Path) -> tuple[int | None, int | None]:
    if Image is None:
        return None, None

    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return None, None


def download_streckenflug_images(
    field_id: str,
    urls: list[str],
    *,
    out_dir: Path = IMAGE_DIR,
    session: requests.Session | None = None,
    sleep_s: float = 0.15,
) -> list[dict[str, Any]]:
    """
    Download full-resolution Streckenflug/Landout shield.php images.

    Stable output format:

        .cache/fr-alps/images/streckenflug/<field_id>/<field_id>_01_<hash>.jpg
    """
    s = session or streckenflug_session()
    field_id = str(field_id)

    target_dir = out_dir / field_id
    target_dir.mkdir(parents=True, exist_ok=True)

    downloaded: list[dict[str, Any]] = []

    for index, url in enumerate(urls, start=1):
        digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]

        response = s.get(
            url,
            timeout=45,
            headers={"Referer": f"{BASE_URL}/index.php?inc=map&iID={field_id}"},
        )
        response.raise_for_status()

        ext = _safe_ext(response.headers.get("content-type"))
        path = target_dir / f"{field_id}_{index:02d}_{digest}{ext}"
        path.write_bytes(response.content)

        width, height = _image_dimensions(path)

        downloaded.append(
            {
                "url": url,
                "path": str(path),
                "bytes": path.stat().st_size,
                "width": width,
                "height": height,
                "content_type": response.headers.get("content-type"),
            }
        )

        if sleep_s:
            time.sleep(sleep_s)

    return downloaded


def fetch_and_download_streckenflug_images(
    field_id: str,
    *,
    session: requests.Session | None = None,
    download: bool = True,
) -> dict[str, Any]:
    """
    Convenience helper for one field.

    Returns:
        {
            "detail": <raw JSON payload>,
            "image_urls": [...],
            "images": [...]
        }
    """
    s = session or streckenflug_session()

    detail = fetch_streckenflug_detail(field_id, session=s)
    urls = extract_streckenflug_image_urls(detail)

    images: list[dict[str, Any]]
    if download:
        images = download_streckenflug_images(field_id, urls, session=s)
    else:
        images = [{"url": url, "path": None} for url in urls]

    return {
        "detail": detail,
        "image_urls": urls,
        "images": images,
    }


def enrich_item_with_streckenflug_images(
    item: dict[str, Any],
    *,
    id_key: str = "id",
    download: bool = True,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """
    Attach full-resolution Streckenflug image metadata to an existing dict item.

    Adds:
        item["streckenflug_image_urls"]
        item["streckenflug_images"]
    """
    field_id = str(item[id_key])
    result = fetch_and_download_streckenflug_images(
        field_id,
        session=session,
        download=download,
    )

    item["streckenflug_image_urls"] = result["image_urls"]
    item["streckenflug_images"] = result["images"]

    return item
