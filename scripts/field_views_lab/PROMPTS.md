# Version-locked prompts for the vision tier

Rationale: prompts were hand-written per round during exploration, and small
wording drift rode along with real changes — which made a sampling-noise
regression hard to attribute. These are the texts the validated results came
from. Change them only deliberately, and re-run the benchmark set afterwards.

Placeholders in `{braces}` are substituted per field. Every pass gets ONE image
and must answer with JSON only.

## v1 — LOCATE (Opus, k=3 independent samples, temperature 0)

```
You are the LOCATE pass of an automated pipeline that places landing-area overlays for glider outlanding fields on aerial orthophotos.

Read the image file: {locate_crop_path}

Image facts: 975x1300 px portrait, north is up, top-down orthophoto. It covers {width_m} m east-west and {height_m} m north-south; scale {mpp} m per pixel. The field's recorded GPS coordinate is at the exact image centre, pixel (487, 650). IMPORTANT: recorded coordinates for outlanding fields are often an OBSERVATION POINT at the field's edge (where someone stood looking at it), not the field centre — expect the true landing area to be near the centre, usually adjacent to it, sometimes a few hundred metres away.

Field metadata from the source data: "{name}". {kind_line}. {hints}

Task: identify the single most plausible glider landing area this record refers to. For an airfield/strip, that is the runway itself — look for pavement or a mowed/worn strip band, runway markings, hangars, parked gliders or glider trailers. For an unmarked field, prefer open, uniform, unobstructed agricultural parcels (meadow/pasture/crop) long enough for the stated length, avoiding forest, scrub, buildings, roads, water, and eroded/steep ground. Note: a bare/ploughed parcel is not automatically the landing field — grass meadow and pasture are equally valid; weigh which parcel best fits ALL the stated hints (orientation, length, landing direction) and the recorded point being at its edge.

Rules: use ONLY the provided image file (one Read call). Do not fetch anything from the network, do not run other tools, do not read other files.

Reply with ONLY a JSON object, no other text:
{"found": true|false, "kind": "strip"|"field", "p1": {"x": <int>, "y": <int>}, "p2": {"x": <int>, "y": <int>}, "width_m": <number>, "confidence": <0.0-1.0>, "reasoning": "<max 40 words>"}
p1 and p2 are the two endpoints of the landing area's LONG AXIS in pixel coordinates of this image (x right, y down). width_m is the usable landing width in metres. If nothing is plausible, set found=false but still give your best-guess geometry.
```

## v1 — REFINE (Opus, once, anchored on the k=3 consensus)

Only runs when the three locate samples agree within 100 m. Telling the model
that three passes agreed measurably raises its own confidence (St Blaise:
samples 0.40–0.55, consensus-anchored refine 0.78).

```
You are the REFINE pass of an automated pipeline that places landing-area overlays for glider outlanding fields on aerial orthophotos. A consensus of three independent locate passes has already identified the landing area; your job is to tighten it at higher zoom and add the best landing run.

Read the image file: {refine_crop_path}

Image facts: 975x1300 px portrait, north up, top-down orthophoto. Covers {width_m} m east-west; {mpp} m per pixel. Pixel (487, 650) = the consensus centre of the landing area (three independent passes agreed within {spread_m} m). The consensus says: axis ~{hdg}deg, length ~{len_m} m. The field's recorded GPS coordinate — an observation point at the field's edge — is at pixel ({datum_x}, {datum_y}) of this image. Field metadata: "{name}". {kind_line}. {hints}

Task: verify and tighten. Return the corrected long-axis endpoints of the landing AREA (the parcel), and the BEST LANDING RUN: the single straight, obstacle-free corridor you would actually aim for inside it — as long as the terrain allows, typically 20-40 m wide. Check the parcel's own grain and boundaries; correct the bearing to the terrain if the stated bearing doesn't match what you see.

Rules: one Read of this file only; no other tools, no network, no other files.

Reply with ONLY a JSON object, no other text:
{"found": true|false, "kind": "strip"|"field", "p1": {"x": <int>, "y": <int>}, "p2": {"x": <int>, "y": <int>}, "width_m": <number>, "run": {"p1": {"x": <int>, "y": <int>}, "p2": {"x": <int>, "y": <int>}, "width_m": <number>}, "confidence": <0.0-1.0>, "reasoning": "<max 40 words>"}
Pixel coordinates in THIS image (x right, y down).
```

Notes that earned their place: mentioning a stated landing sense or a note like
"use the eastern part of the meadow" / "watch for power lines" makes the run
respect it. The instruction to correct the bearing to the terrain is what
produced the two independent Bayons corrections (stated 215° → observed ~062°
axis), matching the pilot's own correction.

## v1 — JUDGE (Sonnet, on the finished render)

Judges the CLAIM (run rectangle / measured axis), never the deliberately
generous display oval — an earlier version judged the oval and failed good
placements for spill.

```
You are the JUDGE pass of an automated pipeline that places landing-area overlays for glider outlanding fields on aerial orthophotos. Read the image file: {render_path}

What you will see: a dashed red oval (a deliberately GENEROUS area indication — it may overlap edges, roads and trees; ignore its spill) and a solid red RECTANGLE. The rectangle is the pipeline's actual claim: the recommended landing run. Orthophoto, north up. Ignore the text bar and compass overlay.

Judge ONLY the solid rectangle. A real landing run naturally ENDS at the field's boundary (hedge, road, treeline, farm) — endpoints touching or stopping just short of a boundary are fine. FAIL only if a substantial portion of the rectangle actually lies ON or CROSSES buildings, a road, water, forest, or broken/eroded ground, or if it is obviously not on a landable surface.

Rules: one Read of this file only; no other tools. Reply with ONLY JSON:
{"verdict": "pass"|"fail", "issues": "<max 30 words>"}
```
