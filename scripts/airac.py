"""AIRAC cycle selection shared by the pack build (Austro Control ZIPs) and the ENAV fetcher.

One policy, two publishers: pick the latest already-effective cycle — AIP portals
pre-publish upcoming AIRAC cycles — and fall back to the earliest future one when none is
effective yet, so a source listing only pre-published cycles still yields something usable.
Callers adapt their publisher's cycle-name format into (effective date, cycle) pairs.
"""
from __future__ import annotations

import datetime as dt


def pick_effective(dated_cycles: list[tuple[dt.date, str]], today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    dated = sorted(set(dated_cycles))
    if not dated:
        return ""
    effective = [cycle for date, cycle in dated if date <= today]
    return effective[-1] if effective else dated[0][1]
