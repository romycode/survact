#!/usr/bin/env python3
"""
gettext workflow for Survact (xgettext + msgmerge + msginit, without needing GNU gettext).

Godot's own POT generator only reads GDScript and scenes, not C#, so this tool extracts from:
  - C#:     Tr("text") and TrN("singular", "plural", n) with string LITERALS.
            A `// TRANSLATORS: ...` comment applies to the Tr() calls on the next code line.
  - Scenes: text / placeholder_text / tooltip_text in game/scenes/**/*.tscn, skipping nodes with
            auto_translate_mode = 2 (disabled) and anything under scenes/debug/.

Source language is English: the msgid IS the English text. Missing translations fall back to it.

Usage:
  python3 tools/i18n.py extract          # write game/i18n/strings.pot
  python3 tools/i18n.py update           # extract + merge into every game/i18n/*.po (keeps translations)
  python3 tools/i18n.py init <lang>      # create game/i18n/<lang>.po from the template
  python3 tools/i18n.py check            # list untranslated/fuzzy entries; exit 1 if any
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME = ROOT / "game"
I18N = GAME / "i18n"
POT = I18N / "strings.pot"

PLURAL_FORMS = {
    "es": "nplurals=2; plural=(n != 1);",
    "en": "nplurals=2; plural=(n != 1);",
    "fr": "nplurals=2; plural=(n > 1);",
    "de": "nplurals=2; plural=(n != 1);",
    "pt_BR": "nplurals=2; plural=(n > 1);",
    "ca": "nplurals=2; plural=(n != 1);",
    "ru": "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    "ja": "nplurals=1; plural=0;",
}

STR = r'"((?:[^"\\]|\\.)*)"'
TR_RE = re.compile(r'\bTr\(\s*' + STR + r'\s*[,)]')
TRN_RE = re.compile(r'\bTrN\(\s*' + STR + r'\s*,\s*' + STR)
TRANSLATORS_RE = re.compile(r'//\s*TRANSLATORS:\s*(.*)')
SCENE_PROP_RE = re.compile(r'^(text|placeholder_text|tooltip_text)\s*=\s*' + STR + r'\s*$')


@dataclass
class Entry:
    msgid: str
    plural: str | None = None
    msgstr: list[str] = field(default_factory=lambda: [""])
    refs: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    fuzzy: bool = False


# ---------------------------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------------------------
def unescape(s: str) -> str:
    return bytes(s, "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8")


def extract() -> dict[str, Entry]:
    entries: dict[str, Entry] = {}

    def add(msgid: str, ref: str, plural: str | None = None, note: str | None = None) -> None:
        e = entries.setdefault(msgid, Entry(msgid, plural))
        if plural and not e.plural:
            e.plural = plural
        e.refs.append(ref)
        if note and note not in e.notes:
            e.notes.append(note)

    for path in sorted((GAME / "src").rglob("*.cs")):
        rel = path.relative_to(ROOT).as_posix()
        pending_note: str | None = None
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if m := TRANSLATORS_RE.search(line):
                pending_note = m.group(1).strip()
                continue
            found = False
            for m in TRN_RE.finditer(line):
                add(unescape(m.group(1)), f"{rel}:{n}", plural=unescape(m.group(2)), note=pending_note)
                found = True
            for m in TR_RE.finditer(line):
                add(unescape(m.group(1)), f"{rel}:{n}", note=pending_note)
                found = True
            if found or line.strip():
                pending_note = None if found or not line.strip().startswith("//") else pending_note

    for path in sorted((GAME / "scenes").rglob("*.tscn")):
        rel = path.relative_to(ROOT).as_posix()
        if "/debug/" in f"/{path.relative_to(GAME / 'scenes').as_posix()}":
            continue
        node_props: list[tuple[int, str]] = []
        disabled = False

        def flush() -> None:
            if not disabled:
                for n, text in node_props:
                    if text.strip():
                        add(text, f"{rel}:{n}")

        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.startswith("["):
                flush()
                node_props, disabled = [], False
            elif line.strip() == "auto_translate_mode = 2":
                disabled = True
            elif m := SCENE_PROP_RE.match(line.strip()):
                node_props.append((n, unescape(m.group(2))))
        flush()

    return entries


# ---------------------------------------------------------------------------------------------
# PO read / write
# ---------------------------------------------------------------------------------------------
def quote(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t") + '"'


def write_po(path: Path, header: dict[str, str], entries: list[Entry], obsolete: list[Entry] = ()) -> None:
    out = ['msgid ""', 'msgstr ""']
    out += [quote(f"{k}: {v}\n") for k, v in header.items()]
    for e in entries:
        out.append("")
        out += [f"#. {note}" for note in e.notes]
        out += [f"#: {ref}" for ref in e.refs]
        if e.fuzzy:
            out.append("#, fuzzy")
        out.append(f"msgid {quote(e.msgid)}")
        if e.plural is not None:
            out.append(f"msgid_plural {quote(e.plural)}")
            for i, s in enumerate(e.msgstr):
                out.append(f"msgstr[{i}] {quote(s)}")
        else:
            out.append(f"msgstr {quote(e.msgstr[0])}")
    for e in obsolete:
        out += ["", f"#~ msgid {quote(e.msgid)}", f"#~ msgstr {quote(e.msgstr[0] if e.msgstr else '')}"]
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def read_po(path: Path) -> tuple[dict[str, str], dict[str, Entry]]:
    header: dict[str, str] = {}
    entries: dict[str, Entry] = {}
    cur: Entry | None = None
    field_name: str | None = None
    fuzzy = False

    def finish() -> None:
        nonlocal cur
        if cur is None:
            return
        if cur.msgid == "":
            for raw in cur.msgstr[0].split("\n"):
                if ": " in raw:
                    k, v = raw.split(": ", 1)
                    header[k] = v
        else:
            entries[cur.msgid] = cur
        cur = None

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#~"):
            finish()
            fuzzy = False
            continue
        if line.startswith("#,"):
            fuzzy = "fuzzy" in line
            continue
        if line.startswith("#"):
            continue
        if line.startswith("msgid_plural "):
            cur.plural = unescape(line[13:].strip()[1:-1])
            field_name = "plural"
        elif line.startswith("msgid "):
            finish()
            cur = Entry(unescape(line[6:].strip()[1:-1]), fuzzy=fuzzy)
            fuzzy = False
            field_name = "msgid"
        elif m := re.match(r"msgstr(?:\[(\d+)\])?\s+(.*)", line):
            idx = int(m.group(1) or 0)
            while len(cur.msgstr) <= idx:
                cur.msgstr.append("")
            cur.msgstr[idx] = unescape(m.group(2)[1:-1])
            field_name = f"msgstr{idx}"
        elif line.startswith('"') and cur is not None:
            text = unescape(line[1:-1])
            if field_name == "msgid":
                cur.msgid += text
            elif field_name == "plural":
                cur.plural = (cur.plural or "") + text
            elif field_name and field_name.startswith("msgstr"):
                cur.msgstr[int(field_name[6:])] += text
    finish()
    return header, entries


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------
def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M+0000")


def cmd_extract() -> dict[str, Entry]:
    entries = extract()
    I18N.mkdir(parents=True, exist_ok=True)
    write_po(POT, {
        "Project-Id-Version": "Survact",
        "POT-Creation-Date": now(),
        "MIME-Version": "1.0",
        "Content-Type": "text/plain; charset=UTF-8",
        "Content-Transfer-Encoding": "8bit",
    }, [Entry(e.msgid, e.plural, [""] * (2 if e.plural else 1), e.refs, e.notes) for e in entries.values()])
    print(f"{len(entries)} strings -> {POT.relative_to(ROOT)}")
    return entries


def cmd_update() -> None:
    template = cmd_extract()
    for po in sorted(I18N.glob("*.po")):
        header, old = read_po(po)
        nplurals = int(re.search(r"nplurals=(\d+)", header.get("Plural-Forms", "nplurals=2")).group(1))
        merged = []
        for t in template.values():
            e = Entry(t.msgid, t.plural, refs=t.refs, notes=t.notes)
            prev = old.get(t.msgid)
            e.msgstr = (prev.msgstr if prev else [""] * (nplurals if t.plural else 1))
            if t.plural and len(e.msgstr) < nplurals:
                e.msgstr += [""] * (nplurals - len(e.msgstr))
            e.fuzzy = prev.fuzzy if prev else False
            merged.append(e)
        obsolete = [e for k, e in old.items() if k not in template and any(e.msgstr)]
        header["PO-Revision-Date"] = now()
        write_po(po, header, merged, obsolete)
        missing = sum(1 for e in merged if not all(e.msgstr) or e.fuzzy)
        print(f"{po.relative_to(ROOT)}: {len(merged)} entries, {missing} need translation, {len(obsolete)} obsolete")


def cmd_init(lang: str) -> None:
    template = extract()
    po = I18N / f"{lang}.po"
    if po.exists():
        sys.exit(f"{po.relative_to(ROOT)} already exists; use 'update'")
    plural = PLURAL_FORMS.get(lang, "nplurals=2; plural=(n != 1);")
    nplurals = int(re.search(r"nplurals=(\d+)", plural).group(1))
    write_po(po, {
        "Project-Id-Version": "Survact",
        "PO-Revision-Date": now(),
        "Language": lang,
        "MIME-Version": "1.0",
        "Content-Type": "text/plain; charset=UTF-8",
        "Content-Transfer-Encoding": "8bit",
        "Plural-Forms": plural,
    }, [Entry(e.msgid, e.plural, [""] * (nplurals if e.plural else 1), e.refs, e.notes) for e in template.values()])
    print(f"created {po.relative_to(ROOT)} ({len(template)} strings). Add it in Project Settings → Localization.")


def cmd_check() -> None:
    template = extract()
    bad = 0
    for po in sorted(I18N.glob("*.po")):
        _, entries = read_po(po)
        problems = []
        for msgid in template:
            e = entries.get(msgid)
            if e is None:
                problems.append(f"missing (run update): {msgid!r}")
            elif e.fuzzy:
                problems.append(f"fuzzy: {msgid!r}")
            elif not all(e.msgstr):
                problems.append(f"untranslated: {msgid!r}")
        status = "ok" if not problems else f"{len(problems)} problem(s)"
        print(f"{po.relative_to(ROOT)}: {status}")
        for p in problems:
            print(f"  {p}")
        bad += len(problems)
    sys.exit(1 if bad else 0)


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in {"extract", "update", "init", "check"}:
        sys.exit(__doc__)
    match sys.argv[1]:
        case "extract": cmd_extract()
        case "update": cmd_update()
        case "init":
            if len(sys.argv) != 3:
                sys.exit("usage: i18n.py init <lang>")
            cmd_init(sys.argv[2])
        case "check": cmd_check()


if __name__ == "__main__":
    main()
