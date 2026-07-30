# Shape inventory — what the guides actually draw

Built by looking at all 162 Guide des Aires de Sécurité photos and all 43 APVV Pyrenees
captures, 2026-07-30. The point is to replace guesswork with a list: "transfer every
shape" is achievable by covering the shapes that exist, and this is that set.

Why a catalogue rather than a general ink detector: recognising ink in the abstract was
tried and measured, and it fails — a drawn black ring and a hedgerow are the same pixels
by colour (S=54/V=60 against S=67/V=58) and the same by pen statistics (width, spread and
branching all identical). See the FINDINGS note in `ink.py`. The shape prior is not an
arbitrary restriction; it is the only thing that separates ink from ground.

## Two drawing styles, not one

The Aires corpus splits cleanly, and the split predicts which shapes appear:

- **Framed** (a coloured border, number badge, title bar, scale bar, N arrow). Older,
  cartographic. Draws filled strips and black rings.
- **Screenshot** (no border, sometimes a UI pill bottom-right). Newer, from a mapping
  tool. Draws measured arrows with text labels, outlined polygons and point markers.

The APVV captures are a third style: Google Earth with a black N arrow top-left, drawing
orange outlined polygons, thick red arrows and yellow hazard annotations.

## The catalogue

| # | shape | corpus | appearance | detection status |
|---|---|---|---|---|
| 1 | **filled strip** | Aires framed | translucent yellow-green quad, often with a dark outline | working — saturation floor S≥120 separates ink (S=148) from meadow (S=86) |
| 2 | **ring / ellipse** | Aires framed | unfilled black stroke, circle or ellipse round the landable area | working — hole in the dark mask, area/fitted-ellipse 0.93–1.07 |
| 3 | **ring + strip together** | Aires framed | a ring containing a filled strip (132 Sainte Jalle) | both fire independently; needs no new work |
| 4 | **measured arrow** | Aires screenshot | red, pink, blue or white line with `<length> m` and `<bearing>°` beside it | working, but fragments where the label crosses the shaft |
| 5 | **several measured arrows** | Aires screenshot | 2–4 per photo, different directions, sometimes different colours | working — collinear grouping keeps them separate |
| 6 | **outlined polygon** | Aires screenshot, APVV | bright yellow-green or orange hand-traced boundary, unfilled, irregular | **partly** — traced for APVV, not implemented for the Aires screenshot style |
| 7 | **long straight hazard line** | Aires screenshot | a red line crossing the whole frame, usually a power line | **missing** — currently ignored, and it is a safety annotation |
| 8 | **point marker** | Aires screenshot, APVV | small amber/orange filled dot, sometimes several | **missing** |
| 9 | **circled point** | Aires screenshot, APVV | small red or yellow circle round a feature, often labelled (`Barrage`) | **missing** |
| 10 | **danger rectangle** | Aires screenshot | red rectangle, outlined or translucently filled | working (Bayons) |
| 11 | **hazard line + text** | APVV | yellow line with a caption (`Partie à éviter`, `Talus`, `Caniveau`) | **missing** — line is drawable, the caption is not transferable |
| 12 | **range arc** | APVV | white curved line with a distance label (`1300m`) | **missing**, and probably should stay so — see below |
| 13 | **thin centreline** | Aires framed | single or crossed yellow lines marking usable runs (211 Artignosc) | **missing** |

## Not aerial at all

`529_chauffayer_3` is a ground-level photograph of a field with a text caption, filed
among the aerial views. Transferring it is meaningless, and the pipeline must recognise
that a photo is not a vertical aerial view and skip it rather than register it. There may
be more; a check on the photo itself (horizon, sky, aspect) is cheaper than finding them
by eye.

## What this implies

1. **Four kinds are missing and three of them are safety information** — the hazard line
   (7), the point marker (8), the circled obstacle (9) and the APVV hazard line (11). A
   pilot losing a marked power line is worse than a pilot losing a field outline.
2. **Captions cannot transfer.** `Partie à éviter` next to a line is meaningful only where
   it sits; re-rendered at a different scale it would be unreadable, and the earlier
   decision was that legends and labels do not belong on the view. Draw the geometry,
   drop the words.
3. **Range arcs (12) should not transfer.** They are an artefact of the guide's own page
   scale, not a feature of the ground.
4. **The two Aires styles want different extractors.** Framed photos never carry measured
   arrows; screenshots never carry filled strips. Detecting the style first — which
   `is_framed` already does — lets each extractor run only where its shapes can occur,
   which removes a whole class of false positive for free.

## Order of work

Highest value first, judged by how much a pilot loses if it stays missing:

1. hazard line (7) and APVV hazard line (11) — safety
2. point marker (8) and circled obstacle (9) — safety
3. outlined polygon for the Aires screenshot style (6) — coverage
4. thin centreline (13) — coverage
5. non-aerial photo detection — correctness
6. arrow fragmentation where a label crosses the shaft — quality

Each one gets a golden-set entry as it lands, so the next pass can be measured rather
than eyeballed.
