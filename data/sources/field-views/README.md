# Field views — source archive

Irreplaceable source material from the guides. **Nothing here is consumed by a pipeline
today**: the attempt to lift the drawings off these photos and re-project them onto current
imagery was abandoned in 2026-07 (see `scripts/field_views_lab/NOTES.md`). It is kept
because it cannot be re-fetched — the sources are old links that may disappear, and for the
Pyrenees guide the pack has become the effective source.

## Layout

- `guide-photos/` — one-time snapshot (2026-07-29) of every annotated photo embedded in
  planeur-net's `guide_aires_securite.cupx`, byte-identical, original filenames.
  `meta.json` records the source URL, its sha256 and the retrieval date. planeur-net
  already publishes these openly and the packs have always redistributed them.
- `pyr-google/` — the annotated Google Earth captures from the APVV "Guide des champs
  pyrénéens" (2008), cropped from the entry pages (source PDF URL + sha256 in `meta.json`,
  per-entry data in `index.json`). **Never packed or served**: Google imagery cannot be
  redistributed. Archive only.

The Pyrenees guide PDF itself is archived at `data/sources/apvv-pyrenees/`, and
`scripts/extract_pyr_guide.py` still extracts its field records into the pack.

## What the pack actually ships

Generated views come from OSM runway geometry drawn on current orthophotos — see
`scripts/field_views.py` and the `generate-field-views` workflow. Only fields with an OSM
runway get one; the rest have no generated view.

Generation is a **one-time build event**, not part of the nightly pack build. A refresh is
a deliberate, manual act — worth doing when the national imagery programmes publish a new
campaign, yearly at most — and never silent: pilots memorise these views.

Renders themselves are **not** stored in git: they are derived from OSM plus current
orthophotos, and at pack scale they are hundreds of MB. Git holds the irreplaceable inputs;
R2 holds the derived, re-creatable output.
