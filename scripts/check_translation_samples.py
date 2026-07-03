#!/usr/bin/env python3
"""Fast local checks for importer translation samples."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_PACK = ROOT / "scripts" / "build_pack.py"


def load_build_pack():
    spec = importlib.util.spec_from_file_location("build_pack", BUILD_PACK)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {BUILD_PACK}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    build_pack = load_build_pack()
    notes = build_pack.build_streckenflug_notes_from_json({
        "art": "Landout Field",
        "kategorie": "B - Caution",
        "oberflaeche": "Grass Runway",
        "richtung": "-/33",
        "steigung": "Slightly ascending",
        "last_check_year": "2025",
        "modified": "31.03.2025",
        "z_uneben": "1",
        "feedback": """
            <p><b>22.03.2025, Nora Geusen</b></p>
            <p>wie unten beschrieben</p>
            <p><b>25.03.2023, Jan Lyczywek</b></p>
            <p>Besichtigung am 24.03.2023 UL-Piste mit Windsack.
            Ansteigend von Südost nach Nordwest, Landung daher nur von Südost nach Nordwest.
            Zwei weiße, kegelförmige Landereiter markieren die Schwelle.
            Aufsetzen nicht vor der Schwelle, da der Boden davor uneben ist.
            Aufsetzen aber auch nicht weit nach der Schwelle, da bei langem Ausrollen bergauf Richtung Nordwest der Boden zunehmend unebener wird.
            Am besten sind die ersten 150 Meter nach der Schwelle.
            Aus der Luft sieht das Feld farblich scheckig, uneinheitlich und dadurch schlechter aus, als es ist.
            Ringsum sind aber auch viele landwirtschaftliche Felder.
            Schwierige Wahl; bei der UL-Piste weiß man zumindest, was man hat.
            Im März 2023 war die Piste eher schlecht gepflegt, mit einzelnen kleinen dornigen Büschen hier und da.
            Besichtigungs-Video: https://youtu.be/MPwdcnZwAEU</p>
            <p><b>13.07.2022, Tore Graeber</b></p>
            <p>Hallo, die Oberfläche von Montgardin ist in der Datei als Asphaltpiste eingetragen.
            Dies ist nicht korrekt, bei der Oberfläche handelt es sich um Gras.
            Viele Grüße! Tore Graeber</p>
        """,
    })

    expected = [
        "As described below",
        "UL strip with windsock",
        "Climbs from southeast to northwest; land only from southeast to northwest",
        "Two white cone-shaped markers indicate the threshold",
        "The first 150 m after the threshold are best",
        "This is not correct; the surface is grass",
    ]
    for text in expected:
        if text not in notes:
            raise AssertionError(f"Missing expected translation: {text!r}\n\n{notes}")
    if "Landout Field · B - Caution" in notes:
        raise AssertionError(f"Difficulty/type header should not be duplicated in notes:\n\n{notes}")

    leftovers = re.findall(
        r"\b(?:Ansteigend|Aufsetzen|Ausrollen|Besichtigung|Boden|Büschen|Datei|Felder|Grüße|Landung|Oberfläche|Piste|Schwelle|Windsack|beschrieben|kegelförmige|uneben)\b",
        notes,
        flags=re.I,
    )
    if leftovers:
        raise AssertionError(f"German leftovers in Montgardin sample: {sorted(set(leftovers))}\n\n{notes}")
    if "http://" in notes or "https://" in notes:
        raise AssertionError(f"Unexpected URL in translated sample:\n\n{notes}")
    if "Feedback:\n- " not in notes:
        raise AssertionError(f"Feedback is not bullet formatted:\n\n{notes}")

    french = "ZA Vaste ZA. Attention au mais. Vent variable. Ligne HT."
    translated_french = build_pack.translate_streckenflug_text(french)
    if translated_french != french:
        raise AssertionError(f"French text should stay untouched:\n{translated_french}")

    common_german = build_pack.translate_streckenflug_text(
        "Frisch gemäht. Entlang der Straße ist ein Zaun. Südlichen Teil der Wiese benützen"
    )
    for text in [
        "Freshly mowed",
        "There is a fence along the road",
        "Use the southern part of the meadow",
    ]:
        if text not in common_german:
            raise AssertionError(f"Missing common German translation {text!r}:\n{common_german}")
    common_leftovers = re.findall(r"\b(?:gemäht|Straße|Zaun|Südlichen|Wiese|benützen)\b", common_german, flags=re.I)
    if common_leftovers:
        raise AssertionError(f"German leftovers in common sample: {sorted(set(common_leftovers))}\n\n{common_german}")

    mixed = build_pack.translate_streckenflug_text(
        "Feld ist eben und bretthart. Nur kleinere Steine zwischendrin. --- ZA Choisir en fct cultures."
    )
    if "Field is flat and very hard" not in mixed or "ZA Choisir en fct cultures." not in mixed:
        raise AssertionError(f"Mixed German/French sample was not handled correctly:\n{mixed}")

    print("OK: translation samples are readable")
    print(notes)
    print("\nCommon sample:", common_german)
    print("French sample:", translated_french)
    print("Mixed sample:", mixed)


if __name__ == "__main__":
    main()
