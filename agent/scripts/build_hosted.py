"""Bundle the Navigator, its two desks, and everything they use into one file for an Agentverse-hosted agent.

    uv run python scripts/build_hosted.py          # write hosted/navigator_hosted.py
    uv run python scripts/build_hosted.py --check  # exit 1 if that file is out of date (the tests run this)

The modules are copied in dependency order with their package-relative imports removed, so the hosted agent runs
exactly the code the tests cover. The build fails if two modules define the same name, if a relative import names
something no earlier module defines, or if any import is outside what Agentverse-hosted agents allow.
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1]
PACKAGE = AGENT_DIR / "tend_agent"
OUT = AGENT_DIR / "hosted" / "navigator_hosted.py"
MODULES = [
    "states",
    "fmt",
    "parse",
    "knowledge",
    "check",
    "settings",
    "cards",
    "api",
    "messages",
    "desks",
    "demo",
    "letter",
    "packet",
    "share",
    "law",
    "bank",
    "sessions",
    "navigator",
    "chat",
    "hosted",
]
# Third-party packages an Agentverse-hosted agent may import (Agentverse docs, "Allowed Imports"), plus the
# standard library.
ALLOWED = {"uagents", "uagents_core", "httpx", "pydantic", "Crypto", "cryptography"}

HEADER = '''"""Tend Navigator, as an Agentverse-hosted agent (always on).

GENERATED FILE. Do not edit by hand: it is built from agent/tend_agent by agent/scripts/build_hosted.py, and the
tests check that it matches. Paste the whole file into a new hosted agent on agentverse.ai (steps in
agent/AGENTVERSE.md).

What it does in one ASI:One chat: cited answers about crime victim compensation in all 50 states and DC (or "not in
the rules I have"), a Check, and a fictional demo claim run end to end: costs from Capital One's Nessie mock bank, the
forensic exam line held under the state's law with a letter to billing, the rest of the bill paid only after the
person types the server's 6-digit code, and an encrypted link for an advocate. It never asks for a name or a story.

Locally the Law and Bank+Packet desks are separate uAgents; here they run in this one process, calling the same
public Tend API. Allowed imports only: uagents, uagents_core, httpx, pycryptodome (or cryptography), and the
standard library.
"""

# The Tend deployment this agent calls. Change these two lines to point the agent somewhere else.
TEND_API_URL = "https://youreowed.tech"  # the API, served under /api
TEND_PUBLIC_URL = "https://youreowed.tech"  # the web app, where an advocate opens a share link
'''

FOOTER = """

# ======================================================================== Agentverse entry point

from uagents import Agent  # noqa: E402 - Agentverse provides the hosted agent through this class

agent = Agent()
attach(agent, hosted_settings(TEND_API_URL, TEND_PUBLIC_URL))

if __name__ == "__main__":
    agent.run()
"""


class BundleError(Exception):
    pass


def _stdlib(name: str) -> bool:
    return name in sys.stdlib_module_names


def _top_names(tree: ast.Module) -> dict[str, str]:
    """name -> what it is: "def" for definitions, "import:<origin>" for imports."""
    out: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out[node.name] = "def"
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                for n in ast.walk(t):
                    if isinstance(n, ast.Name):
                        out[n.id] = "def"
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out[node.target.id] = "def"
        elif isinstance(node, ast.For):
            for n in ast.walk(node.target):
                if isinstance(n, ast.Name):
                    out[n.id] = "def"
        elif isinstance(node, ast.Import):
            for a in node.names:
                out[a.asname or a.name.split(".")[0]] = f"import:{a.name}"
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module != "__future__":
            for a in node.names:
                out[a.asname or a.name] = f"import:{node.module}.{a.name}"
    return out


def _module_source(name: str, defined: dict[str, tuple[str, str]]) -> str:
    path = PACKAGE / f"{name}.py"
    source = path.read_text()
    tree = ast.parse(source)
    drop: set[int] = set()
    doc = ast.get_docstring(tree, clean=False)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level > 0:
            for a in node.names:
                if a.name not in defined:
                    raise BundleError(f"{name}.py imports {a.name} from .{node.module}, which no earlier module defines")
                if a.asname and a.asname != a.name:
                    raise BundleError(f"{name}.py renames {a.name} on import; the bundle cannot")
            drop.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
        elif isinstance(node, ast.ImportFrom) and node.module == "__future__":
            drop.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            roots = [a.name.split(".")[0] for a in node.names] if isinstance(node, ast.Import) else [(node.module or "").split(".")[0]]
            for root in roots:
                if root not in ALLOWED and not _stdlib(root):
                    raise BundleError(f"{name}.py imports {root}, which Agentverse-hosted agents cannot use")
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            drop.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    if doc is not None and isinstance(tree.body[0], ast.Expr):
        drop.update(range(tree.body[0].lineno, (tree.body[0].end_lineno or tree.body[0].lineno) + 1))
    for item, kind in _top_names(tree).items():
        if item == "__all__":
            continue
        seen = defined.get(item)
        if seen and (kind == "def" or seen[1] == "def" or seen[1] != kind):
            raise BundleError(f"{item} is defined in both {seen[0]}.py and {name}.py; rename one")
        defined[item] = (name, kind)
    body = "\n".join(line for i, line in enumerate(source.splitlines(), 1) if i not in drop).strip("\n")
    title = f"# {'=' * 72} {name}.py"
    comment = "\n".join(f"# {line}".rstrip() for line in (doc or "").strip().splitlines())
    return f"\n\n{title}\n{comment}\n\n{body}\n" if comment else f"\n\n{title}\n\n{body}\n"


def build() -> str:
    defined: dict[str, tuple[str, str]] = {}
    parts = [HEADER] + [_module_source(name, defined) for name in MODULES] + [FOOTER]
    text = "".join(parts)
    compile(text, str(OUT), "exec")  # a syntax error fails the build, not the paste
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bundle the hosted Navigator into one file")
    parser.add_argument("--check", action="store_true", help="exit 1 if hosted/navigator_hosted.py is out of date")
    args = parser.parse_args(argv)
    text = build()
    if args.check:
        current = OUT.read_text() if OUT.is_file() else ""
        if current != text:
            print("hosted/navigator_hosted.py is out of date: run uv run python scripts/build_hosted.py", file=sys.stderr)
            return 1
        print("hosted/navigator_hosted.py is up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(AGENT_DIR)} ({len(text.splitlines())} lines, {len(text.encode()) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
