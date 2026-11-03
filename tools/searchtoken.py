"""Shortest search tokens: for each text in a pool, the shortest lower-case piece of it that
no other text in the pool contains (and that isn't in the text every such item carries), so
the game's search box finds exactly that one. Shared by tools/make_mapmods.py-style
generators (tools/make_searchdata.py).

The game's search is case-insensitive and treats the box as a regex, so tokens skip the
regex metacharacters; digits are skipped too (rolls vary). A token may also hit another text
when that text holds the very same line (the same effect), via same_line.
"""
import re

META = set(".^$*+?()[]{}|\\")
MAX_TOKEN = 30


def candidates(text, max_len=MAX_TOKEN):
    """Every substring of text, shortest first: no #/digits, no regex metacharacters, no
    space at either end."""
    s = text.lower()
    seen = set()
    for n in range(2, min(max_len, len(s)) + 1):
        for i in range(0, len(s) - n + 1):
            t = s[i:i + n]
            if t in seen or t[0] == " " or t[-1] == " " or "#" in t or re.search(r"\d", t) or META & set(t):
                continue
            seen.add(t)
            yield t


def shortest_tokens(texts, common="", min_len=2, max_len=MAX_TOKEN):
    """{text: token or None} for each text: the shortest piece found in no other text and
    not in `common` (text shown on every item searched). Ties: a token without spaces,
    then alphabetical."""
    low = [t.lower() for t in texts]
    common = common.lower()
    out = {}
    for i, t in enumerate(low):
        best = None
        for c in candidates(t, max_len):
            if len(c) < min_len:
                continue
            if best and len(c) > len(best[0]):
                break
            if c in common or any(c in o for j, o in enumerate(low) if j != i):
                continue
            if best is None:
                best = [c]
            else:
                best.append(c)
        if best:
            best.sort(key=lambda c: (" " in c, c))
            out[texts[i]] = best[0]
        else:
            out[texts[i]] = None
    return out


def escape(text):
    """A literal piece of text as search regex (metacharacters escaped)."""
    return "".join("\\" + ch if ch in META else ch for ch in text)


def whole_or_token(text, token):
    """The token, or the whole name escaped when nothing shorter singles it out (a name that
    is part of another name, e.g. "Abyss Scarab" in "Abyss Scarab of Crystals", is matched
    as itself followed by the end of the line)."""
    return token if token else escape(text.lower()) + "$"
