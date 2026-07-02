#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
fields = json.loads((root / "data/packs/fr-alps/fields.json").read_text(encoding="utf-8"))
assert fields, "fields.json is empty"
for field in fields:
    for key in ["id", "name", "latitude", "longitude", "difficulty", "media"]:
        assert key in field, f"{field.get('name', '?')}: missing {key}"
    assert -90 <= field["latitude"] <= 90, field
    assert -180 <= field["longitude"] <= 180, field
print(f"OK: {len(fields)} fields")
