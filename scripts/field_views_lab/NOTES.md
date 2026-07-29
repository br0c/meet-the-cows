# Field views — validated state of the feature (2026-07-29)

Working notes for the generated-satellite-view feature. Everything below was
established interactively against pilot memory (Fabien) and blind model evals;
it is the ground truth the production pipeline is built and measured against.

## Architecture (settled)

Per field, in order:

1. **OSM tier** — an `aeroway=runway` way within 1 km of the field's coordinate:
   use its geometry as-is (centre, heading, length, width, surface). No model
   calls, deterministic, free. Runways mapped as closed areas get a centreline
   via principal axis (`field_views.py`). Coverage measured on all 2,790 fields:
   **2,439 (87.4%)** — AT 100%, DE 97%, CH 96%, IT 92%, FR 81%, ES 78%.
   Radius is insensitive (2 km adds only 12 fields). Only 12/130 outlanding
   fields are OSM-mapped; the tier is overwhelmingly the airfield-kind records.
2. **Vision tier** (the other 351 fields, of which 234 have no media at all):
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

## Why k=3 (variance evidence, Prunières)

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
| Veneto IDT | `rv:ortofoto_agea_2024` | 2024 |
| Alto Adige | `gvcc-Orthoimagery:Aerial-*-RGB` | long annual run |
| Trentino | `stem:qu_ortofoto_2015` | 2015 |
| PCN national | `OI.ORTOIMMAGINI.2012.32` / `.33` | 2012 — fallback only |

Lombardia, Piemonte and FVG endpoints still need finding. Prefer regional over PCN wherever a
region covers the field: the national layer is fourteen years old, and while it is legally fine
it is weak evidence for the question these views answer.

Technical notes: PCN answers only WMS **1.1.1** with `EPSG:32632/32633` (UTM 32/33 — the layer
name's trailing number IS the zone), not 1.3.0/4326. Regional services vary. Like Germany, Italy
needs per-provider CRS and version rather than the single 4326 assumption the fetcher makes.

National portals stop dead at their borders (IGN returns blank white 2 km into
Italy). Provider follows the field's country. Google imagery is excluded
outright (no redistribution right). Attribution is burned into every render;
OSM-derived runways add "Runway © OpenStreetMap contributors".

Vision tier by country: FR 222, ES 69, IT 39, DE 19, CH 2, AT 0 — 83% of the
vision work sits on proven providers. WMS quirk: different zooms can serve
different imagery vintages (a parcel may flip grass↔ploughed between crops);
pin the fetch scale, and expect the judge to occasionally veto on appearance.

## Model + cost decisions

- LOCATE/REFINE: **Opus** (Sonnet failed 2 of 3 hard benchmarks, 211–664 m).
- JUDGE: **Sonnet** (Haiku invents obstacles on close calls).
- Batches API, temperature 0 pinned, prompts version-locked (PROMPTS.md).
- One-off cost for the 351-field vision tier at k=3: roughly $60–80.
- Observed pipeline integrity: agents refuse to fabricate geometry when the
  input image is missing — keep prompts that make refusal easy.

## Still to do

- Vision API module in `field_views.py` (client behind ANTHROPIC_API_KEY,
  consensus/union math from `consensus_run.py`, prompts from PROMPTS.md).
- Judge-feedback retry before falling back (rescues near-misses).
- Border-clip detection (blank-margin check on crops).
- AT WMTS stitch; DE per-Land and IT per-region provider tables.
- Pack/app integration decision: bundle generated views as media vs serve
  on-demand like charts (~500 MB across packs if bundled).
- Terrain-tile slope check over proposed areas (data already shipped in-app).
