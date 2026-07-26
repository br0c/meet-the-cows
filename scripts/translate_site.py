#!/usr/bin/env python3
"""Translate the landing page with DeepL, keeping its markup and its vocabulary.

The page is hand-authored HTML, and three things have to survive the round trip:

  Structure. Blocks are sent as HTML fragments (tag_handling=html) rather than as bare strings,
  so <strong> and <br /> come back where they belong — and so DeepL sees a whole sentence instead
  of the shards a text-node walk would hand it. Fragments are the unit; attributes are sent the
  same way and unwrapped afterwards.

  Vocabulary. Gliding French is not general French: a glide ratio is a finesse, sink is a
  descendance, and an outlanding is a vache. Left alone DeepL produces fluent prose that no
  vélivole would write, so site/i18n/glossary.en-fr.tsv is uploaded as a DeepL glossary and every
  request uses it. This is the difference between a usable translation and a plausible one.

  Names. site/i18n/protect.txt lists what must come through untouched — the product, the hosts,
  and the aviation acronyms. Those are wrapped in <x-keep> and named in ignore_tags, which is
  DeepL's documented mechanism; the wrapper never reaches the file. (Elements marked
  translate="no" are widely said to be skipped too, but that is not in the API reference, and a
  brand name silently translated is not the place to rely on folklore.)

Hand-written overrides win over anything DeepL returns: site/i18n/overrides.<lang>.json maps an
English fragment to the exact translation to use. It exists for the lines where the machine cannot
know what is going on — a pun, a house phrase — and starts empty on purpose, so a first run
measures DeepL rather than measuring the overrides.

  DEEPL_API_KEY=... python scripts/translate_site.py --lang fr
  python scripts/translate_site.py --lang fr --dry-run     # no key needed, shows what would be sent
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
KEEP_TAG = "x-keep"

# Blocks whose inner HTML is translated as one unit. Anything not inside one of these is left
# alone, which is what keeps <script>, <style> and the nav's own markup out of the way.
BLOCK_TAGS = {"h1", "h2", "h3", "p", "li", "title", "figcaption", "small"}
# Elements inside a block that must not start their own block (they are part of its sentence).
INLINE_TAGS = {"strong", "b", "em", "i", "span", "a", "br", "small", "code", "abbr"}
# (tag, attribute) pairs carrying human text.
TEXT_ATTRS = {("meta", "content"), ("img", "alt")}
META_TRANSLATE = {"description", "og:title", "og:description"}


def api_url(key: str, override: str = "") -> str:
    if override:
        return override.rstrip("/")
    return "https://api-free.deepl.com/v2" if key.endswith(":fx") else "https://api.deepl.com/v2"


def _no_translate(start_tag: str) -> bool:
    """translate="no" on a block keeps it out of the extraction entirely.

    The English page carries one line that is already French — the offer of the French version —
    and sending French to a French translator is both a waste and a way to get it subtly reworded.
    """
    return re.search(r'\btranslate\s*=\s*"no"', start_tag) is not None


class Blocks(HTMLParser):
    """Split the document into a token list, marking which spans are translatable blocks."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.tokens: list[tuple[str, str]] = []      # (kind, text) — kind: raw | block
        self.depth = 0
        self.open_tag = ""
        self.buffer: list[str] = []
        self.skip = 0

    def _emit(self, text: str) -> None:
        if self.depth:
            self.buffer.append(text)
        else:
            self.tokens.append(("raw", text))

    def handle_starttag(self, tag, attrs):
        raw = self.get_starttag_text() or ""
        if tag in ("script", "style"):
            self.skip += 1
            self._emit(raw)
            return
        if self.skip:
            self._emit(raw)
            return
        if self.depth == 0 and tag in BLOCK_TAGS and not _no_translate(raw):
            self.tokens.append(("raw", raw))
            self.depth = 1
            self.open_tag = tag
            self.buffer = []
            return
        if self.depth and tag == self.open_tag and tag not in INLINE_TAGS:
            self.depth += 1
        self._emit(raw)

    def handle_startendtag(self, tag, attrs):
        self._emit(self.get_starttag_text() or "")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
            self._emit(f"</{tag}>")
            return
        if self.depth and tag == self.open_tag:
            self.depth -= 1
            if self.depth == 0:
                self.tokens.append(("block", "".join(self.buffer)))
                self.tokens.append(("raw", f"</{tag}>"))
                self.buffer = []
                self.open_tag = ""
                return
        self._emit(f"</{tag}>")

    def handle_data(self, data):
        self._emit(data)

    def handle_entityref(self, name):
        self._emit(f"&{name};")

    def handle_charref(self, name):
        self._emit(f"&#{name};")

    def handle_comment(self, data):
        self._emit(f"<!--{data}-->")

    def handle_decl(self, decl):
        self._emit(f"<!{decl}>")


def load_protect(path: Path) -> list[str]:
    terms = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()]
    terms = [t for t in terms if t and not t.startswith("#")]
    # Longest first so "Guide des Aires de Sécurité" is matched before "Guide des Aires".
    return sorted(terms, key=len, reverse=True)


def protect(fragment: str, terms: list[str]) -> str:
    """Wrap do-not-translate terms so ignore_tags can see them, skipping ones already wrapped."""
    for term in terms:
        pattern = re.compile(rf"(?<!<{KEEP_TAG}>)\b{re.escape(term)}\b(?!</{KEEP_TAG}>)")
        fragment = pattern.sub(f"<{KEEP_TAG}>{term}</{KEEP_TAG}>", fragment)
    return fragment


def unprotect(fragment: str) -> str:
    return re.sub(rf"</?{KEEP_TAG}\s*/?>", "", fragment)


class DeepL:
    def __init__(self, key: str, base: str, source: str, target: str) -> None:
        self.key = key
        self.base = base
        self.source = source
        self.target = target
        self.glossary_id = ""
        self.chars = 0
        self.calls = 0

    def _post(self, path: str, fields: dict) -> dict:
        request = urllib.request.Request(
            f"{self.base}{path}",
            data=urllib.parse.urlencode(fields, doseq=True).encode(),
            headers={"Authorization": f"DeepL-Auth-Key {self.key}",
                     "Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = response.read().decode("utf-8")
                    return json.loads(body) if body else {}
            except urllib.error.HTTPError as error:
                if error.code == 429:
                    retry = (error.headers or {}).get("Retry-After")
                    time.sleep(float(retry) if (retry or "").isdigit() else min(2 ** attempt, 16))
                    continue
                detail = error.read().decode("utf-8", "replace")[:300]
                raise SystemExit(f"DeepL HTTP {error.code} on {path}: {detail}") from error
        raise SystemExit(f"DeepL kept rate-limiting {path}")

    def ensure_glossary(self, entries: str, name: str) -> None:
        """Upload the domain glossary. Cheap and disposable — one per run, deleted at the end."""
        if not entries.strip():
            return
        created = self._post("/glossaries", {
            "name": name,
            # Glossary pairs use the base language; EN variants are interchangeable for this.
            "source_lang": self.source.split("-")[0].upper(),
            "target_lang": self.target.split("-")[0].upper(),
            "entries": entries,
            "entries_format": "tsv",
        })
        self.glossary_id = created.get("glossary_id", "")
        print(f"glossary {self.glossary_id} — {created.get('entry_count', '?')} entries",
              file=sys.stderr)

    def drop_glossary(self) -> None:
        if not self.glossary_id:
            return
        request = urllib.request.Request(
            f"{self.base}/glossaries/{self.glossary_id}",
            headers={"Authorization": f"DeepL-Auth-Key {self.key}"}, method="DELETE")
        try:
            urllib.request.urlopen(request, timeout=20).close()
        except Exception as error:  # noqa: BLE001 - a leaked glossary is untidy, not fatal
            print(f"could not delete glossary: {error}", file=sys.stderr)

    def translate(self, fragment: str) -> str:
        fields = {
            "text": fragment,
            "source_lang": self.source.split("-")[0].upper(),
            "target_lang": self.target.upper(),
            "tag_handling": "html",
            "ignore_tags": KEEP_TAG,
            "preserve_formatting": "1",
        }
        if self.glossary_id:
            fields["glossary_id"] = self.glossary_id
        payload = self._post("/translate", fields)
        self.calls += 1
        self.chars += len(fragment)
        translations = payload.get("translations") or []
        return translations[0].get("text", fragment) if translations else fragment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lang", default="fr", help="Target language (a DeepL code, e.g. fr, de)")
    parser.add_argument("--source", default="en")
    parser.add_argument("--in", dest="source_page", default=None,
                        help="Source page (default site/public/index.html)")
    parser.add_argument("--out", default=None,
                        help="Where to write (default site/public/<lang>/index.html)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be sent, translate nothing, need no key")
    parser.add_argument("--stub", action="store_true",
                        help="Round-trip the machinery with a fake translator, to prove the HTML "
                             "survives without spending a single character")
    parser.add_argument("--api-key", default=os.environ.get("DEEPL_API_KEY", ""))
    parser.add_argument("--api-url", default=os.environ.get("DEEPL_API_URL", ""))
    parser.add_argument("--report", default=None, help="Write a before/after Markdown table here")
    args = parser.parse_args()

    source_page = Path(args.source_page) if args.source_page else SITE / "public" / "index.html"
    out_page = Path(args.out) if args.out else SITE / "public" / args.lang / "index.html"
    document = source_page.read_text(encoding="utf-8")

    terms = load_protect(SITE / "i18n" / "protect.txt")
    glossary_file = SITE / "i18n" / f"glossary.{args.source}-{args.lang}.tsv"
    glossary = glossary_file.read_text(encoding="utf-8") if glossary_file.is_file() else ""
    overrides_file = SITE / "i18n" / f"overrides.{args.lang}.json"
    overrides = json.loads(overrides_file.read_text(encoding="utf-8")) if overrides_file.is_file() else {}

    parser_ = Blocks()
    parser_.feed(document)
    parser_.close()

    # Attributes carrying prose, found by a second pass over the raw tokens.
    def attr_jobs(raw: str) -> list[str]:
        if not raw.startswith("<"):
            return []
        tag = re.match(r"<\s*([a-zA-Z0-9-]+)", raw)
        if not tag:
            return []
        name = tag.group(1).lower()
        out = []
        for attr, value in re.findall(r'([a-zA-Z-]+)\s*=\s*"([^"]*)"', raw):
            if (name, attr.lower()) not in TEXT_ATTRS or not value.strip():
                continue
            if name == "meta":
                which = re.search(r'(?:name|property)\s*=\s*"([^"]*)"', raw)
                if not which or which.group(1) not in META_TRANSLATE:
                    continue
            out.append(value)
        return out

    jobs: list[str] = []
    for kind, text in parser_.tokens:
        if kind == "block" and text.strip():
            jobs.append(text)
        elif kind == "raw":
            jobs.extend(attr_jobs(text))
    unique = list(dict.fromkeys(jobs))
    billable = sum(len(protect(j, terms)) for j in unique if j not in overrides)
    print(f"{len(unique)} unique fragments, ~{billable:,} characters to DeepL "
          f"({len(overrides)} pinned by hand)", file=sys.stderr)

    if args.dry_run:
        for fragment in unique:
            print(f"  {'[pinned] ' if fragment in overrides else ''}{fragment[:110]}")
        return

    translated: dict[str, str] = {}
    client = None
    if args.stub:
        for fragment in unique:
            translated[fragment] = overrides.get(fragment) or unprotect(protect(fragment, terms))
    else:
        if not args.api_key:
            raise SystemExit("No DEEPL_API_KEY. Use --dry-run to see the fragments, or --stub to "
                             "exercise the machinery without one.")
        client = DeepL(args.api_key, api_url(args.api_key, args.api_url), args.source, args.lang)
        client.ensure_glossary(glossary, f"mtc-site-{args.source}-{args.lang}-{int(time.time())}")
        try:
            for fragment in unique:
                if fragment in overrides:
                    translated[fragment] = overrides[fragment]
                    continue
                translated[fragment] = unprotect(client.translate(protect(fragment, terms)))
        finally:
            client.drop_glossary()

    # Rebuild the page. Attribute values are HTML-escaped on the way back in; block fragments are
    # already markup and go in as they are.
    out: list[str] = []
    for kind, text in parser_.tokens:
        if kind == "block":
            out.append(translated.get(text, text) if text.strip() else text)
            continue
        rebuilt = text
        for value in attr_jobs(text):
            new = translated.get(value)
            if new and new != value:
                rebuilt = rebuilt.replace(f'"{value}"', '"' + html.escape(new, quote=True) + '"')
        out.append(rebuilt)
    page = "".join(out)

    # Relocate the page: it now lives one directory down and is a different language.
    page = page.replace('<html lang="en"', f'<html lang="{args.lang}"')
    page = re.sub(r'(href|src)="(?!https?:|//|#|\.\./)([^"]+)"', r'\1="../\2"', page)
    page = page.replace(f'href="../{args.lang}/"', 'href="../"')
    page = page.replace('rel="canonical" href="https://meetthecows.org/"',
                        f'rel="canonical" href="https://meetthecows.org/{args.lang}/"')
    page = page.replace('property="og:url" content="https://meetthecows.org/"',
                        f'property="og:url" content="https://meetthecows.org/{args.lang}/"')

    out_page.parent.mkdir(parents=True, exist_ok=True)
    out_page.write_text(page, encoding="utf-8")
    if client:
        print(f"{client.calls} calls, {client.chars:,} characters", file=sys.stderr)
    print(f"wrote {out_page}", file=sys.stderr)

    if args.report:
        rows = ["| English | " + args.lang.upper() + " |", "|---|---|"]
        for fragment in unique:
            got = translated.get(fragment, "")
            if got.strip() == fragment.strip():
                continue
            cell = lambda s: s.replace("|", "\\|").replace("\n", " ").strip()
            rows.append(f"| {cell(fragment)} | {cell(got)}"
                        f"{' _(pinned)_' if fragment in overrides else ''} |")
        Path(args.report).write_text("\n".join(rows) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
