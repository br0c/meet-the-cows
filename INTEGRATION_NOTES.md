# Integration notes

Add this import where your Streckenflug importer loops over items:

```python
from meet_the_cows.sources.streckenflug_images import (
    enrich_item_with_streckenflug_images,
    streckenflug_session,
)
```

Then inside the loop, assuming each item has an `"id"` field:

```python
session = streckenflug_session()

for item in items:
    try:
        enrich_item_with_streckenflug_images(item, session=session)
    except Exception as exc:
        item["streckenflug_image_urls"] = []
        item["streckenflug_images"] = [{"error": str(exc)}]
```

Each enriched item gets:

```python
item["streckenflug_image_urls"]
item["streckenflug_images"]
```

with entries like:

```python
{
    "url": "...shield.php?...",
    "path": ".cache/fr-alps/images/streckenflug/339/339_01_abcd1234ef.jpg",
    "bytes": 1234567,
    "width": 3435,
    "height": 1951,
    "content_type": "image/jpeg",
}
```
