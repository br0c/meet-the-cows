## Streckenflug / Landout full-resolution images

The Streckenflug/Landout map page only embeds basic marker data directly in the HTML. The useful per-field details, including photos and feedback, are loaded through the JSON endpoint used by the page sidebar:

```text
https://landout.streckenflug.at/json.php?inc=map&task=landeplatz&id=<field_id>
```

The project downloads full-resolution images from the `shield.php` URLs found in the `fotos` and `feedback` HTML snippets of that JSON payload.

Images are cached under:

```text
.cache/fr-alps/images/streckenflug/<field_id>/
```

Example verification:

```bash
python - <<'PY'
from meet_the_cows.sources.streckenflug_images import (
    fetch_streckenflug_detail,
    extract_streckenflug_image_urls,
    download_streckenflug_images,
)

field_id = "339"

detail = fetch_streckenflug_detail(field_id)
urls = extract_streckenflug_image_urls(detail)

print("urls:", len(urls))
for url in urls:
    print(url)

images = download_streckenflug_images(field_id, urls)

print("\ndownloaded:")
for image in images:
    print(image)
PY
```

For Achensee, the expected result is 2 full-resolution images, one around 3435×1951 and one around 1200×900.

Pillow is used only to record downloaded image dimensions.
