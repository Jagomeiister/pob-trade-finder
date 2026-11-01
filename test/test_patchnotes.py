"""Settings → Patch notes data — run: python test/test_patchnotes.py

tools/make_patchnotes.py turns docs/release-notes-v*.md into plain data (no HTML): the title
line, paragraphs, **Bold line** subheadings, "- " lists nested by indent with wrapped lines
joined, and inline bold / italic / code / https links. Markup in a note stays text. Every
release-notes file in docs/ parses to a title and some content."""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import make_patchnotes as pn  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # notes hold → and other non-cp1252 text
failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


MD = """## v9.9.9: a *test* release

Intro line one
continues here.

**New**

- **Settings → Patch notes** shows
  every release, with `code`.
  - nested *item* and a [link](https://example.com/x)
- second <img src=x> item

Plain paragraph with **bold** text.
"""

n = pn.parse(MD)
check("title from the ## line", n["title"] == "a *test* release", n["title"])
b = n["blocks"]
check("wrapped paragraph lines are joined", b[0] == {"p": [["t", "Intro line one continues here."]]}, b[0])
check("**Bold line** is a subheading", b[1] == {"h": [["t", "New"]]}, b[1])
items = b[2]["ul"]
check("wrapped list lines join the item before inline parsing",
      items[0]["li"] == [["b", "Settings → Patch notes"], ["t", " shows every release, with "], ["c", "code"], ["t", "."]],
      items[0]["li"])
check("nested items, italic and https links",
      items[0]["ul"][0]["li"] == [["t", "nested "], ["i", "item"], ["t", " and a "], ["a", "link", "https://example.com/x"]],
      items[0]["ul"])
check("markup stays text", items[1]["li"] == [["t", "second <img src=x> item"]], items[1])
check("inline bold in a paragraph", b[3] == {"p": [["t", "Plain paragraph with "], ["b", "bold"], ["t", " text."]]}, b[3])
check("only https links become links", pn.inline("[x](javascript:alert(1))") == [["t", "[x](javascript:alert(1))"]],
      pn.inline("[x](javascript:alert(1))"))
check("an asterisk in a sentence is not italic", pn.inline("5 * 3 and 2 * 4") == [["t", "5 * 3 and 2 * 4"]],
      pn.inline("5 * 3 and 2 * 4"))
check("versions sort numerically", sorted(["v2.5.9", "v2.5.10", "v2.4.2"], key=pn.version_key) == ["v2.4.2", "v2.5.9", "v2.5.10"])

# every shipped release-notes file parses to a title and content
bad = []
for fn in os.listdir(pn.DOCS):
    if re.match(r"^release-notes-v\d+\.\d+\.\d+\.md$", fn):
        with open(os.path.join(pn.DOCS, fn), encoding="utf-8") as f:
            r = pn.parse(f.read())
        if not r["title"] or not r["blocks"]:
            bad.append(fn)
check("every docs/release-notes-v*.md has a title and content", not bad, bad)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
