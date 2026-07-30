# Field views — validated state of the feature (2026-07-30)

Working notes for the generated-satellite-view feature. Everything below was
established interactively against pilot memory (Fabien) and blind model evals;
it is the ground truth the production pipeline is built and measured against.

**What the feature is today:** OSM runway geometry drawn on current orthophoto imagery,
for airfields. A field with no OSM runway gets no generated view. The photo-transfer
pass that aimed to cover the rest was abandoned on 2026-07-30 and its code deleted —
see below for why, and read that before restarting it.

## Architecture

**Built and running:** step 1 only. Steps 2 and 3 were designed and measured but never
shipped, and the code for them is gone — the sections below are kept as evidence for
whoever restarts the problem, not as a description of what exists.

Per field, in order:

1. **OSM tier** — an `aeroway=runway` way within 1 km of the field's coordinate:
   use its geometry as-is (centre, heading, length, width, surface). No model
   calls, deterministic, free. Runways mapped as closed areas get a centreline
   via principal axis (`field_views.py`). Coverage measured on all 2,790 fields:
   **2,439 (87.4%)** — AT 100%, DE 97%, CH 96%, IT 92%, FR 81%, ES 78%.
   Radius is insensitive (2 km adds only 12 fields). Only 12/130 outlanding
   fields are OSM-mapped; the tier is overwhelmingly the airfield-kind records.
2. **Vision tier — NEVER BUILT** (the other 351 fields, of which 234 have no media at
   all). Designed and benchmarked as below; no code for it remains:
   k=3 independent LOCATE samples (Opus) on a clean 1800 m portrait crop →
   agreement gate (max pairwise centre distance ≤ 100 m):
   - **agree** → one REFINE pass (Opus) on a crop centred on the consensus,
     returning tightened area axis + a "best landing run" rectangle → tight
     dashed oval + solid run rectangle;
   - **disagree** → **union oval** covering all sample axes, labelled as an
     area of uncertainty, no run rectangle claimed. Wrong info is worse than
     no info; the union oval is the honest fallback.
   Then a JUDGE pass (Sonnet — Haiku disqualified, it confabulates obstacles)
   vets the run/axis on the finished render; judge fail → union-oval/fallback.
3. Generate **once**, cache in R2, only regenerate deliberately. Users must
   never see run-to-run variance.

## Why k=3 (variance evidence, Prunières) — historical, vision tier never built

Three byte-identical Opus locate runs (same prompt, same crop) spread up to
**230 m** pairwise; individual errors vs the validated centre were 147/106/30 m,
while the **mean of the three was 29 m** — better than any single run,
including the first lucky one (61 m). Sampling temperature is not controllable
via in-session agents; the API pins it. Consensus both stabilises the result
and *measures* per-field ambiguity (Prunières' corridor genuinely admits
several 450 m windows).

Consensus rerun on the three benchmarks: Bayons 31 m / 0° (refine corrected
stated 215° to terrain 062°, twice independently), St Blaise 57 m / 6°,
Prunières → disagree → union oval centred 45 m off, sized to the spread.

## Validated benchmark placements (metres E/N of the recorded coordinate)

The recorded coordinate is treated as an OBSERVATION POINT (field edge), not
the centre. All validated by pilot memory over four rounds.

| field | lat | lon | kind | dx | dy | hdg | len |
|---|---|---|---|---|---|---|---|
| La Motte du Caire | 44.3246 | 6.0313 | strip | 0 | -60 | 181 | 880 |
| Barcelonnette LFMR | 44.3883 | 6.6097 | strip | -45 | -115 | 92 | 900 |
| Sollières LFKD | 45.2544 | 6.8006 | strip | 65 | -15 | 15 | 620 |
| Crots | 44.5369 | 6.4357 | strip | -70 | -40 | 62 | 300 |
| Prunières | 44.5342 | 6.3633 | oval | -45 | -35 | 310 | 300 |
| St Blaise | 44.8728 | 6.6100 | oval | -235 | -95 | 58 | 260 |
| Bayons | 44.3358 | 6.1633 | oval | 105 | 185 | 62 | 350 |

(Roche de Rame deliberately skipped — exact field uncertain.)

OSM cross-check on the strips: centre error 32–77 m, heading ≤ 5°, vs blind
vision 9–613 m. OSM lengths disagree both ways (Barcelonnette 715 threshold-to-
threshold vs 900 usable pavement; La Motte 1097 mapped vs 880 usable) — OSM is
authoritative for centre/heading; length may be reconciled with source data.

## Imagery providers (licence-gated: no confirmed-open provider → no view)

| country | provider | licence | status |
|---|---|---|---|
| FR | IGN Géoplateforme WMS | Licence Ouverte | proven extensively |
| ES | PNOA WMS | CC BY 4.0-style | endpoint tested |
| CH | swisstopo SWISSIMAGE WMS | open data, attribution | endpoint tested |
| AT | basemap.at orthophoto WMTS | Open Government Data Lizenz Österreich | **confirmed**, see below |
| DE | per-Land DOP WMS | CC BY 4.0 / DL-DE-BY-2.0 per Land | **confirmed for 11 Länder**, see below |
| IT | regional geoportals (+ PCN national) | open by law — CAD art. 52 c.2 | **confirmed**, see below |

### Austria — clear to use

basemap.at publishes a 30 cm orthophoto as WMTS (tile template
`https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg`,
verified serving). It is a cooperation of the Länder GIS offices (geoland.at), covers the whole
country and refreshes every two months. The licence is Austria's Open Government Data licence:
free including commercial use, conditioned on the credit **"Datenquelle: basemap.at"** (or
"Grundkarte: basemap.at") rendered as a link to basemap.at. Being WMTS not WMS, it needs a
tile-stitch path rather than a GetMap call — the one piece of work Austria still costs.

### Germany — clear to use, Land by Land

There is no usable national DOP service (the BKG endpoint answers 403), but the Länder publish
their own, and most are open data with a named licence. Confirmed serving real imagery AND
carrying an open licence in their GetCapabilities:

| Land | licence | layer |
|---|---|---|
| Bayern | CC BY 4.0 | `DOP40` (`geoservices.bayern.de/od/wms/dop/v1/dop40`) |
| Niedersachsen | CC BY 4.0 | `WMS_NI_DOP20` |
| Schleswig-Holstein | CC BY 4.0 | `sh_dop20_rgb` |
| Baden-Württemberg | DL-DE/BY-2.0 | `IMAGES_DOP_20_RGB` |
| Rheinland-Pfalz | DL-DE/BY-2.0 | `wms_rp_dop20` |
| Brandenburg | DL-DE/BY-2.0 | `bebb_dop20c` (`isk.geobasis-bb.de/mapproxy/dop20c/service/wms`) |
| Thüringen | DL-DE/BY-2.0 | `th_dop20rgb` — **projected CRS only** |
| Nordrhein-Westfalen | open data, gebührenfrei (VermKatG NRW) | `WMS_NW_DOP` |
| Sachsen | kostenfrei, terms on geoportal.sachsen.de | `sn_dop_020` |
| Mecklenburg-Vorpommern | free, attribution obligatory | `WMS_MV_DOP` |
| Sachsen-Anhalt | service open; licence text not in the capabilities — verify | `lsa_lvermgeo_dop20_2` |

Still to locate: Hessen, Berlin, Hamburg, Bremen, Saarland (the URLs tried all 404, and
Saarland's service advertises no DOP layer). Four of those five are city-states, so the
coverage they represent is small, but Hessen is not.

Implementation cost specific to Germany: several services advertise only ETRS89/UTM
(`EPSG:25832` / `25833`) and no `EPSG:4326` — Thüringen's GetMap fails outright on 4326. The
fetcher currently assumes 4326 lat/lon, so DE needs per-provider CRS with a reprojected bbox.

### Italy — clear to use, by statute

The licence question is settled by Italian law rather than by anything the services say. CAD
(D.Lgs. 82/2005) art. 52 c.2 provides that data a public administration publishes *without
expressly adopting a licence* is **deemed released as open data** ("si intendono rilasciati come
dati di tipo aperto"), which art. 1 c.1 lett. l-bis defines as reusable by anyone including
commercially, at no more than marginal cost. These geoportals are public administrations
publishing with no stated licence, so the open-by-default rule applies directly. Their
`AccessConstraints: none` is consistent with that but is not itself the grant — the OGC spec
treats an omitted constraint and the literal word "none" identically, so the metadata alone would
prove nothing.

Note this reasoning is Italy-specific and deliberately did NOT apply to Spain: ENAIRE's Aviso
Legal expressly reserves all rights and forbids reproduction without written authorisation, which
is exactly the "express adoption of a licence" that switches art. 52 c.2 off. Written permission
was necessary there and is not here.

Attribution is still rendered — the media credit line names the publisher for every source, and
open data terms generally expect the source named even when they do not demand it.

Sources, newest first, which is what matters for judging whether a parcel is still landable:

| service | layer | vintage |
|---|---|---|
| Alto Adige | `p_bz-Orthoimagery:Aerial-2023-RGB`, EPSG:25832 only | 2023 — CC BY 4.0, verified serving |
| PCN national | `OI.ORTOIMMAGINI.2012.32` / `.33`, WMS 1.1.1 | 2012 — open by statute, fallback |

**Italy's regional imagery runs on the portals' CC BY 4.0 (2026-07-30).** The recent regional
services — Piemonte 2024 (`opengis.csi.it/mp/regp_agea_2024`), Veneto 2024, Bolzano 2023 — are
used under the CC BY 4.0 licence their geoportals publish, citing the source as we do
everywhere else.

One thing to know if you read the upstream paperwork and get confused: the AGEA-derived layers
also carry an `AGEA (c) tutti i diritti riservati` notice from MASAF, and a separate
institutional sub-licence governs the raw ECW files handed to Enti Locali. That is why the
credit line names **the service we fetch from** rather than AGEA or MASAF — under CC BY the
attribution runs to the licensor whose grant is being relied on, and each source in this table
carries its own licence. So `Orthophoto © Regione del Veneto (CC BY 4.0)`.

What Italy runs on: Piemonte and Veneto 2024 and Bolzano 2023 where they cover the field, PCN
2012 nationally otherwise. Piemonte's host was refusing connections when this was written
(HTTPS reset, HTTP 503), which the blank-coverage fall-through handles silently — the credit
line on a rendered view is the only way to tell which service actually answered.

## Generation runs in CI, not in a session container (2026-07-30)

Four container recycles during this work destroyed the renders each time, which settled where
generation belongs. `.github/workflows/generate-field-views.yml` is dispatch-only and runs all
three tiers: `inventory.py` unions every published pack's fields, `field_views.py runways` and
`match` do the OSM pass, then `osm_render_all.py` (resume + a 4-worker pool, because these are
public services), `aires_render.py` and `pyr_transfer.py` render. `contact_sheets.py` puts 24
views on a page so a tier can be reviewed by eye rather than as thousands of files, and an
unreadable render draws a red box instead of vanishing quietly.

Where output lands: renders and per-tier `index.json` to R2 under `<channel>/views/`, review
sheets and indexes to GitHub artifacts (30 days). Not git — the same split as the source
archive, which keeps only what cannot be recreated. Dispatch-only is deliberate: views are
stable by design, and a refresh is an act someone chooses, not something the nightly pack
build redoes.

All of this is implemented in `field_views.py` (PROVIDERS table + `ortho_crop`): per-provider
WMS version and CRS with a dependency-free UTM projection, bbox routing with blank-coverage
fall-through for overlapping sub-national services, and a WMTS tile-stitch for basemap.at.
Verified live end-to-end: Bayern, Thüringen (UTM), BW-overlap fall-through, NRW,
Schleswig-Holstein, Bolzano 2023, PCN (Rome and Aosta), basemap.at stitch, IGN France.

National portals stop dead at their borders (IGN returns blank white 2 km into
Italy). Provider follows the field's country. Google imagery is excluded
outright (no redistribution right). Attribution is burned into every render;
OSM-derived runways add "Runway © OpenStreetMap contributors".

Vision tier by country: FR 222, ES 69, IT 39, DE 19, CH 2, AT 0 — 83% of the
vision work sits on proven providers. WMS quirk: different zooms can serve
different imagery vintages (a parcel may flip grass↔ploughed between crops);
pin the fetch scale, and expect the judge to occasionally veto on appearance.

## Model + cost decisions — historical, vision tier never built

- LOCATE/REFINE: **Opus** (Sonnet failed 2 of 3 hard benchmarks, 211–664 m).
- JUDGE: **Sonnet** (Haiku invents obstacles on close calls).
- Batches API, temperature 0 pinned, prompts version-locked (PROMPTS.md, deleted).
- One-off cost for the 351-field vision tier at k=3: roughly $60–80.
- Observed pipeline integrity: agents refuse to fabricate geometry when the
  input image is missing — keep prompts that make refusal easy.

## Photo transfer — abandoned, 2026-07-30

For two days the feature tried to cover the fields OSM does not know by lifting the
drawings off the guides' own photos — colour-masking the ink, registering the old photo
onto current imagery with SIFT, and re-projecting the shapes. It was deterministic and the
registration was genuinely good (100-400 inliers, 2.5-4 m RMS). It was still scrapped, and
the code is deleted rather than parked, because the approach did not converge.

The failure mode was consistent and is the reason not to restart from that code: every fix
aimed at one photo broke another. A saturation floor that removed one field's false strips
deleted another's real arrow. Requiring an arrowhead fixed a power line being drawn as a
landing direction and cost two fields their genuine runs. Claiming a bent cable so it could
not become a run turned it into two "avoid" rectangles over good ground. Each round was
measured, each fix was justified by numbers, and the total never improved for long — the
guides simply draw too many things too many ways for a rule set to cover, and each rule
interacts with the others.

Worth keeping from it, if anyone tries again with fresh eyes:

- The drawn styles really are disjoint, and telling them apart is easy (a framed photo's
  border sits at 1.2-1.9 colour spread, a screenshot's at 33-52).
- Ink is separable from ground by colour ONLY where the ink is saturated. White drawn
  arrows are not separable from white roads by any pixel statistic — ten were measured and
  every one came back inverted or overlapping.
- Reading the lettering beside each run ("240 m / 73.0°") is the one thing that worked
  where pixels could not, because it states the answer instead of inferring it. It also
  hallucinated freely when the prompt showed example values, which is worth knowing.
- A model reading text is cheap and effective; a rule set reading shapes is neither.

None of that is a plan. The honest summary is that a field with no OSM runway currently
gets no generated view, and that is better than a wrong one.


## Still to do

- Border-clip detection (blank-margin check on crops).
- DE: Hessen, Berlin, Hamburg, Bremen and Saarland still have no endpoint, so fields only
  they cover get no crop.
- Pack/app integration decision: bundle generated views as media vs serve on-demand like
  charts.
- Terrain-tile slope check over proposed areas (data already shipped in-app).
- Fields with no OSM runway have no generated view. Whether to cover them at all, and how,
  is an open question — see the abandoned transfer pass above before proposing an answer.
