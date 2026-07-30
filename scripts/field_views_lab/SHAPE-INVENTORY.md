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
| 13 | **thin centreline** | Aires framed | single or crossed yellow lines marking usable runs (211 Artignosc) | implemented, but fires on nothing across the corpus — see open questions |
| 14 | **dashed hazard line** | Aires screenshot | a power line ruled as separate strokes, labelled `Ligne El` (515 Lus) | working — collinear dashes are chained and measured as one line |
| 15 | **outlined danger box** | Aires screenshot | red rectangle drawn hollow rather than filled (320 Bayons) | working — traced as the hole it encloses |
| 16 | **fat arrow** | Aires screenshot | a measured arrow 59 px wide, as wide as some danger boxes (515 Lus) | working — separated from a box by its head, not its width |
| 17 | **white arrow** | Aires screenshot | a measured run drawn in white rather than ink (515 Lus draws two) | working — located by directional opening, accepted only where its label vouches for it |
| 18 | **caption banner** | Aires screenshot | red lettering on a white band across the top (318 Montgardin) | must NOT transfer — the band is measured and excluded |
| 19 | **cartographic screenshot** | Aires | an OSM/topo map, not imagery at all (`LIMW_Aoste_zpa`) | not a field photo; airfields take the OSM tier instead |

## Not aerial at all

`529_chauffayer_3` is a ground-level photograph of a field with a text caption, filed
among the aerial views. Transferring it is meaningless, and the pipeline must recognise
that a photo is not a vertical aerial view and skip it rather than register it.

Now measured rather than listed: a ground shot has a bright, washed-out, low-texture sky
above a busy foreground (top V=238, S=18, bottom 11x more textured) where every aerial
view sits within 20% of a texture ratio of 1. Sweeping the corpus with that test found a
second one nobody had spotted, `422_crots_2.jpg`, confirmed by eye as a ground-level shot
of the Crots landing area.

## Where the counts stand

Measured over all 162 photos, before and after the 2026-07-30 pass:

| family | before | after | note |
|---|---|---|---|
| arrows | 149 | 48 | no photo now reports more than the 4 runs the two 4-run fields carry |
| danger boxes | 55 | 12 | most of the 55 were arrowheads — invented hazards on the landing ground |
| circled points | 20 | 17 | the rest were caption lettering |
| hazard lines | 9 | 11 | dashed cables now chained |

The framed families (strips 38, rings 29) are untouched by the pass, as intended: nothing
in it applies to that style.

## Open questions

- **White arrows (17): solved by reading the label, not by a better threshold.** Locating
  a pale bar was never the problem — a directional opening finds both of 515 Lus' white
  runs at 68.7° and 73.3° against a lettered 68.0° and 73.0°. Deciding a bar is a run is
  what fails geometrically, and structurally so: the ink families work because ink is a
  colour the ground is not, and white is the colour of roads, limestone, rooftops and
  glare. Ten separations were measured and every one is inverted or overlapping; each is
  recorded with its killing number in `white_arrows.py`. The fix is that a bar now ships
  only when a label vouches for it, so an unlettered road is rejected by construction
  rather than by a threshold the next photo breaks. The label also settles direction, which
  the locator cannot: a bar at 73° and one at 253° are the same pixels.
- **Centrelines (13) fire on nothing.** The family is implemented and returns zero across
  the corpus. Either 211 Artignosc's yellow lines fail the thinness test, or the style gate
  puts them on the wrong side. Worth one measurement before either changing or removing it.
- **Is a model needed yet? For one thing, yes, and the measurement now says which.** Not
  for geometry: every family above was recovered from pixels, and the white-arrow locator
  is accurate to a degree. What cannot be recovered from pixels is which pale bars are runs
  — see `white_arrows.py`. The labels settle it and state more besides: `240 m / 73.0°`
  beside an arrow gives the run's length and bearing exactly, where every geometric test
  only infers them. A model reading that text, paired with the locator, finishes the family
  and makes every other transferred run checkable against the drawing rather than trusted.
  That is a narrow, well-defined job — read the lettering, return length and bearing — not
  "let a model find the fields".

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

1. ~~hazard line (7) and APVV hazard line (11)~~ — done, plus dashed cables (14)
2. ~~point marker (8) and circled obstacle (9)~~ — done
3. ~~outlined polygon for the Aires screenshot style (6)~~ — done
4. ~~non-aerial photo detection~~ — done, and it found a second one
5. ~~arrow fragmentation where a label crosses the shaft~~ — done: the glyphs are no
   longer treated as breaks, so the stroke survives its own label
6. ~~white arrows (17)~~ — done, by reading the label rather than by a better threshold
7. thin centreline (13) — coverage, pending the measurement above

Each one gets a golden-set entry as it lands, so the next pass can be measured rather
than eyeballed.
