# Field views — source archive

The generated satellite views will replace the old Guide photos in the packs, which makes
this repository the source of record for them. Everything needed to regenerate, audit or
improve a view is preserved here; everything derivable is not.

## Layout

- `guide-photos/` — one-time snapshot (2026-07-29) of every annotated photo embedded in
  planeur-net's `guide_aires_securite.cupx`, byte-identical, original filenames.
  `meta.json` records the source URL, its sha256 and the retrieval date. These photos are
  the *input* to the transfer pipeline: the drawn shapes on them are the authoritative
  placement, so losing them would make the generated views unauditable. planeur-net
  already publishes them openly and the packs have always redistributed them.
- `transfer/<slug>.json` — the geometry extracted from each photo's drawings (strip quads,
  oval rings, danger rectangles, measured arrows, in metres E/N of the field datum) plus
  registration statistics and provenance. Produced by
  `scripts/field_views_lab/transfer_cv.py`; deterministic, no model call.

## Lifecycle

Generation is a **one-time build event**, not part of the nightly pack build. Renders are
published like any pack media and served as-is. A refresh is a deliberate, manual act —
worth doing when the national imagery programmes publish a new campaign (yearly at most) —
and never silent: pilots memorise these views.

Renders themselves are **not** stored in git: they are derived from the geometry here plus
current orthophotos, and at pack scale they are hundreds of MB. Git holds the irreplaceable
inputs; R2 holds the derived, re-creatable output.
