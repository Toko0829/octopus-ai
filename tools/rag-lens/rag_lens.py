"""rag-lens: one self-contained HTML page showing what the corpus covers,
where retrieval sits relative to its own drop threshold, and what moved
between two eval runs.

    python tools/rag-lens/rag_lens.py
    python tools/rag-lens/rag_lens.py --current services/ai/shards/*.json
    python tools/rag-lens/rag_lens.py --baseline main/*.json --current pr/*.json
    python tools/rag-lens/rag_lens.py --trace rag-trace.json

Stdlib only. No database, no model weights, no virtualenv: the coverage grid and
the run diff are built from files that are already in the repo or already
produced by CI, which is what makes this cheap enough to run every time.

The margin inspector is the one view that needs a live pipeline, because scores
against a threshold only exist once something has actually been reranked. Produce
its input separately with `probe.py`, from the `services/ai` environment.
"""

from __future__ import annotations

import argparse
import glob
import html
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lens_analyze as analyze  # noqa: E402
import lens_data as data  # noqa: E402

E = html.escape


# --- style -------------------------------------------------------------------
#
# Editorial, calm, and legible in both themes (design-system.md: layered ink,
# never pure black; paper-white light shell). Reserved: the accent is used only
# for the threshold rule, because that is the one live measured line on the page.
# Status is never carried by colour alone; every state also has a glyph and a
# word, per AGENTS.md rule 15.

CSS = """
:root {
  --paper: #faf9f7; --panel: #ffffff; --ink: #14171a; --muted: #5c6570;
  --rule: #e3e0da; --rule-soft: #efece7; --accent: #12716f;
  --high: #a02b1f; --medium: #8a6300; --low: #4a5560;
  --ok: #1f6b4a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0d0f12; --panel: #14181d; --ink: #e8e6e1; --muted: #8f9aa5;
    --rule: #242b33; --rule-soft: #1b2027; --accent: #4fd1c5;
    --high: #f0857a; --medium: #d7ab4a; --low: #8f9aa5;
    --ok: #64c9a0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-variant-numeric: tabular-nums;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 48px 28px 96px; }
h1, h2, h3 { font-family: ui-serif, Georgia, "Times New Roman", serif; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 30px; margin: 0 0 6px; }
h2 { font-size: 21px; margin: 52px 0 4px; }
h3 { font-size: 15px; margin: 26px 0 8px; font-family: inherit; text-transform: uppercase;
     letter-spacing: 0.07em; color: var(--muted); font-weight: 600; }
p  { margin: 0 0 12px; max-width: 68ch; }
.sub { color: var(--muted); font-size: 13.5px; }
.rule { border: 0; border-top: 1px solid var(--rule); margin: 8px 0 0; }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
a { color: inherit; text-decoration-color: var(--rule); }

.stats { display: flex; flex-wrap: wrap; gap: 26px; margin: 22px 0 4px; }
.stat .n { font-size: 26px; font-family: ui-serif, Georgia, serif; }
.stat .k { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }

table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
th { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
     border-bottom: 1px solid var(--rule); font-weight: 600; }
td.num, th.num { text-align: right; }
tbody tr:hover { background: var(--rule-soft); }

.grid { border: 1px solid var(--rule); border-radius: 3px; overflow: hidden; }
.grid table { font-size: 13px; }
.grid th, .grid td { border-bottom: 1px solid var(--rule-soft); border-right: 1px solid var(--rule-soft); }
.grid th:first-child, .grid td:first-child { font-weight: 600; background: var(--rule-soft); }
.cell { display: flex; align-items: baseline; gap: 7px; }
.cell .c { font-size: 15px; font-family: ui-serif, Georgia, serif; }
.cell .m { font-size: 11px; color: var(--muted); }
.empty { color: var(--muted); }
.docs { margin: 4px 0 0; padding: 0; list-style: none; font-size: 11.5px; color: var(--muted); }
.docs li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 22ch; }

.tag { display: inline-block; font-size: 10.5px; letter-spacing: 0.05em; text-transform: uppercase;
       border: 1px solid currentColor; border-radius: 2px; padding: 0 5px; line-height: 16px; }
.high { color: var(--high); } .medium { color: var(--medium); }
.low { color: var(--low); } .ok { color: var(--ok); }

.finding { display: grid; grid-template-columns: 74px 1fr; gap: 14px; padding: 11px 0;
           border-bottom: 1px solid var(--rule-soft); }
.finding .what { font-weight: 600; }
.finding .why { color: var(--muted); font-size: 13.5px; margin-top: 2px; }

.probe { border: 1px solid var(--rule); border-radius: 3px; padding: 16px 18px; margin: 14px 0; background: var(--panel); }
.probe .q { font-weight: 600; }
.probe .meta { color: var(--muted); font-size: 12.5px; margin: 3px 0 12px; }
.legend { font-size: 12px; color: var(--muted); display: flex; gap: 18px; margin-top: 8px; align-items: center; }
.legend svg { vertical-align: -2px; }

.note { border-left: 2px solid var(--rule); padding: 2px 0 2px 14px; color: var(--muted); font-size: 13.5px; }
.foot { margin-top: 64px; color: var(--muted); font-size: 12px; }
"""


def _sev_tag(sev: str) -> str:
    return f'<span class="tag {sev}">{E(sev)}</span>'


# --- sections ----------------------------------------------------------------


def render_findings(a: analyze.Analysis) -> str:
    if not a.findings:
        return (
            "<h2>Findings</h2><p class='note'>Nothing to report: every document is "
            "mapped to a stage, every stage names documents that exist, every document "
            "has a golden case, and no measured run contradicted any of that.</p>"
        )
    counts: dict[str, int] = {}
    for f in a.findings:
        counts[f.severity] = counts.get(f.severity, 0) + 1
    summary = ", ".join(f"{counts[s]} {s}" for s in ("high", "medium", "low") if s in counts)
    rows = "".join(
        f'<div class="finding"><div>{_sev_tag(f.severity)}</div>'
        f'<div><div class="what">{E(f.kind)}: <span class="mono">{E(f.subject)}</span></div>'
        f'<div class="why">{E(f.detail)}</div></div></div>'
        for f in a.findings
    )
    return (
        f"<h2>Findings</h2><p class='sub'>{E(summary)}. Each one is a disagreement "
        "between two files that both already exist, or a result measured by a run.</p>"
        f"{rows}"
    )


def render_coverage(a: analyze.Analysis) -> str:
    head = "".join(f"<th>{E(m)}</th>" for m in a.markets)
    rows = []
    for stage in a.stages:
        cells = []
        for market in a.markets:
            cell = a.cell(stage, market)
            if not cell or not cell.docs:
                cells.append('<td class="empty">&mdash;</td>')
                continue
            if cell.proven is True:
                mark, word = "&#9679;", "retrieved"
            elif cell.proven is False:
                mark, word = "&#9675;", "not retrieved"
            elif cell.cases:
                mark, word = "&#9675;", f"{len(cell.cases)} case(s), unrun"
            else:
                mark, word = "&#9633;", "no golden case"
            docs = "".join(f'<li>{E(d.slug)}</li>' for d in cell.docs)
            cells.append(
                f'<td><div class="cell"><span class="c">{len(cell.docs)}</span>'
                f'<span class="m">{mark} {word}</span></div>'
                f'<ul class="docs">{docs}</ul></td>'
            )
        rows.append(f"<tr><td>{E(stage)}</td>{''.join(cells)}</tr>")
    legend = (
        '<div class="legend"><span>&#9679; a golden case proved it retrievable in this run</span>'
        "<span>&#9675; a golden case points here but did not hit, or no run was supplied</span>"
        "<span>&#9633; documents exist and no golden case asks for them</span></div>"
    )
    return (
        "<h2>Coverage</h2>"
        "<p class='sub'>Funnel stage by market. Stages come from the coverage table in "
        "<span class='mono'>docs/30-modules/rag-knowledge.md</span>, markets from the "
        "documents themselves. An empty cell is a question the corpus answers out of "
        "another market's documents.</p>"
        f'<div class="grid"><table><thead><tr><th>Stage</th>{head}</tr></thead>'
        f"<tbody>{''.join(rows)}</tbody></table></div>{legend}"
    )


def render_documents(a: analyze.Analysis) -> str:
    cases_by_title: dict[str, int] = {}
    for c in a.golden:
        for t in c.expect_docs:
            cases_by_title[t] = cases_by_title.get(t, 0) + 1
    rows = []
    for d in sorted(a.documents, key=lambda d: (d.origin, d.slug)):
        n = cases_by_title.get(d.title, 0)
        proof = f"{n}" if n else '<span class="high">0</span>'
        link = (
            f'<a href="{E(d.source_url)}">{E(d.title)}</a>' if d.source_url else E(d.title)
        )
        rows.append(
            f"<tr><td class='mono'>{E(d.slug)}</td><td>{link}</td>"
            f"<td>{E(d.origin)}</td><td>{E(d.market or '-')}</td>"
            f"<td>{E(d.doc_type or '-')}</td><td>{E(d.authority or '-')}</td>"
            f"<td class='num'>{d.words:,}</td><td class='num'>{proof}</td>"
            f"<td class='mono'>{E(d.effective_date or '-')}</td></tr>"
        )
    return (
        "<h2>Documents</h2>"
        "<p class='sub'>Everything <span class='mono'>seed.py</span> ingests: the internal "
        "playbooks and the checked-in crawled snapshots. Golden column is how many positive "
        "cases name this document; a zero there means nothing asserts it is retrievable.</p>"
        "<table><thead><tr><th>Slug</th><th>Title</th><th>Origin</th><th>Market</th>"
        "<th>Type</th><th>Authority</th><th class='num'>Words</th><th class='num'>Golden</th>"
        "<th>Read on</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


def _margin_svg(probe: data.Probe, width: int = 900, height: int = 64) -> str:
    """Candidate rerank scores on a log axis, with the drop threshold as a rule.

    Log rather than linear because the distribution is not comparable between
    providers and spans orders of magnitude within one: bge scores cluster near
    0.001 and Cohere near 0.3, and a linear axis renders either as a single blob
    against the wall.
    """
    scores = [s["rerank_score"] for s in probe.scored if s["rerank_score"] > 0]
    if not scores:
        return "<p class='note'>No candidate scored above zero.</p>"
    floor = probe.threshold if probe.threshold > 0 else min(scores)
    lo = math.log10(min(min(scores), floor) * 0.5)
    hi = math.log10(max(max(scores), floor) * 2.0)
    pad_l, pad_r = 8, 8
    span = max(hi - lo, 1e-9)

    def x(v: float) -> float:
        return pad_l + (math.log10(v) - lo) / span * (width - pad_l - pad_r)

    mid = height / 2
    parts = [
        f'<svg viewBox="0 0 {width} {height}" width="100%" height="{height}" '
        'role="img" aria-label="candidate rerank scores against the drop threshold">',
        f'<line x1="{pad_l}" y1="{mid}" x2="{width - pad_r}" y2="{mid}" '
        'stroke="var(--rule)" stroke-width="1"/>',
    ]
    if probe.threshold > 0:
        tx = x(probe.threshold)
        parts.append(
            f'<line x1="{tx:.1f}" y1="8" x2="{tx:.1f}" y2="{height - 8}" '
            'stroke="var(--accent)" stroke-width="1.5"/>'
            f'<text x="{tx + 5:.1f}" y="16" font-size="10" fill="var(--accent)">'
            f"threshold {probe.threshold:.4g}</text>"
        )
    for s in sorted(probe.scored, key=lambda s: s["rerank_score"]):
        if s["rerank_score"] <= 0:
            continue
        cx = x(s["rerank_score"])
        title = E(f"{s['title']} · {s['rerank_score']:.4g} · {'kept' if s['kept'] else 'dropped'}")
        if s["kept"]:
            parts.append(
                f'<circle cx="{cx:.1f}" cy="{mid}" r="4.5" fill="var(--ink)">'
                f"<title>{title}</title></circle>"
            )
        else:
            parts.append(
                f'<circle cx="{cx:.1f}" cy="{mid}" r="3.5" fill="none" '
                f'stroke="var(--muted)" stroke-width="1.2"><title>{title}</title></circle>'
            )
    parts.append("</svg>")
    return "".join(parts)


def render_margins(a: analyze.Analysis) -> str:
    if not a.trace or not a.trace.probes:
        return (
            "<h2>Margins</h2>"
            "<p class='note'>No trace supplied. This view needs real rerank scores, so it "
            "comes from a live pipeline rather than from files in the repo. Produce one with"
            "<br><span class='mono'>uv run --directory services/ai python "
            "../../tools/rag-lens/probe.py --out ../../rag-trace.json</span><br>then pass "
            "<span class='mono'>--trace rag-trace.json</span>.</p>"
        )
    s = a.trace.settings
    blocks = []
    for p in a.trace.probes:
        margin = p.margin
        if margin is None:
            margin_txt = "no survivor"
            cls = "low"
        else:
            cls = "medium" if margin < analyze.THIN_MARGIN_RATIO else "ok"
            margin_txt = f"top score is {margin:.2f}x the threshold"
        subs = (
            f" · decomposed into {len(p.subqueries)}: "
            + "; ".join(E(q) for q in p.subqueries)
            if len(p.subqueries) > 1
            else ""
        )
        gate = ""
        if p.gate:
            gate = (
                f" · gate: <strong>{E(str(p.gate.get('outcome', '?')))}</strong> "
                f"({E(str(p.gate.get('reason', '')))[:160]})"
            )
        blocks.append(
            f'<div class="probe"><div class="q">{E(p.query)}</div>'
            f'<div class="meta">{len(p.scored)} candidates scored · {p.kept} kept · '
            f'{p.dropped} dropped · <span class="{cls}">{margin_txt}</span>{subs}{gate}</div>'
            f"{_margin_svg(p)}</div>"
        )
    legend = (
        '<div class="legend"><span>&#9679; kept (filled)</span>'
        "<span>&#9675; dropped below threshold (hollow)</span>"
        "<span>log axis; hover a dot for the document and score</span></div>"
    )
    config = " · ".join(
        f"{k}: {v}" for k, v in s.items() if k in
        ("embed_model", "rerank_model", "rerank_min_score", "decomposition", "candidates")
    )
    return (
        "<h2>Margins</h2>"
        "<p class='sub'>Every candidate's rerank score against the drop threshold. The "
        "number that matters is the distance, not the count: a top survivor under "
        f"{analyze.THIN_MARGIN_RATIO:.0f}x the floor is an answer a synonym can turn into a "
        "refusal.</p>"
        + (f"<p class='sub mono'>{E(config)}</p>" if config else "")
        + "".join(blocks)
        + legend
    )


def render_run(a: analyze.Analysis) -> str:
    if not a.current:
        return (
            "<h2>Run</h2>"
            "<p class='note'>No shard results supplied. Pass the JSON the eval already "
            "writes:<br><span class='mono'>python tools/rag-lens/rag_lens.py --current "
            "services/ai/shards/*.json</span></p>"
        )
    results = list(a.current.values())
    positives = [r for r in results if not r.is_negative]
    negatives = [r for r in results if r.is_negative]
    hits = sum(1 for r in positives if r.hit)
    leaks = sum(1 for r in negatives if r.leaked)
    recall = hits / len(positives) if positives else 0.0
    cov = sum(r.coverage for r in positives) / len(positives) if positives else 0.0
    ranks = [r.rank_of_first_hit for r in positives if r.rank_of_first_hit]
    mrr = sum(1 / r for r in ranks) / len(positives) if positives else 0.0

    stats = (
        f'<div class="stats">'
        f'<div class="stat"><div class="n">{recall:.2f}</div><div class="k">recall</div></div>'
        f'<div class="stat"><div class="n">{cov:.2f}</div><div class="k">coverage</div></div>'
        f'<div class="stat"><div class="n">{mrr:.2f}</div><div class="k">MRR</div></div>'
        f'<div class="stat"><div class="n">{leaks}</div><div class="k">leaks</div></div>'
        f'<div class="stat"><div class="n">{len(results)}</div><div class="k">cases</div></div>'
        f"</div>"
    )

    if not a.baseline:
        rows = []
        for r in sorted(results, key=lambda r: (not r.leaked, r.hit, r.id)):
            if r.leaked:
                state = '<span class="high">&#9679; LEAK</span>'
            elif r.is_negative:
                state = '<span class="ok">&#9675; clean</span>'
            elif r.hit:
                state = "&#9679; hit"
            else:
                state = '<span class="medium">&#9679; miss</span>'
            top = f"{r.top_score:.4g}" if r.top_score is not None else "-"
            rows.append(
                f"<tr><td class='mono'>{E(r.id)}</td><td>{E(r.query[:70])}</td>"
                f"<td>{state}</td><td class='num'>{r.rank_of_first_hit or '-'}</td>"
                f"<td class='num'>{r.coverage:.0%}</td><td class='num'>{top}</td></tr>"
            )
        return (
            "<h2>Run</h2><p class='sub'>Thresholds and the pass/fail verdict belong to "
            "<span class='mono'>octopus_ai.evaluation --merge</span>, which is the gate. "
            "This is the same numbers, laid out. Leaks and misses sort to the top.</p>"
            + stats
            + "<table><thead><tr><th>Case</th><th>Query</th><th>Result</th>"
            "<th class='num'>Rank</th><th class='num'>Cov</th><th class='num'>Top</th>"
            "</tr></thead><tbody>" + "".join(rows) + "</tbody></table>"
        )

    deltas = analyze.diff(a.baseline, a.current)
    changed = [d for d in deltas if d.status != "same"]
    rows = []
    for d in deltas:
        mark = {
            "regressed": '<span class="high">&#9660; regressed</span>',
            "fixed": '<span class="ok">&#9650; fixed</span>',
            "moved": '<span class="low">&#9654; moved</span>',
            "new": '<span class="low">+ new</span>',
            "gone": '<span class="medium">&minus; gone</span>',
            "same": '<span class="low">= same</span>',
        }[d.status]

        def cell(r: data.CaseResult | None) -> str:
            if r is None:
                return "&mdash;"
            state = "LEAK" if r.leaked else ("hit" if r.hit else "miss")
            rank = f" @{r.rank_of_first_hit}" if r.rank_of_first_hit else ""
            return f"{state}{rank} · {r.coverage:.0%}"

        rows.append(
            f"<tr><td class='mono'>{E(d.id)}</td><td>{mark}</td>"
            f"<td>{cell(d.before)}</td><td>{cell(d.after)}</td>"
            f"<td>{E(d.query[:60])}</td></tr>"
        )
    return (
        "<h2>Run diff</h2>"
        f"<p class='sub'>{len(changed)} of {len(deltas)} cases changed. Ordered by how much "
        "attention the row deserves: a regression at the bottom of a long table is a "
        "regression nobody reads.</p>" + stats +
        "<table><thead><tr><th>Case</th><th>Change</th><th>Baseline</th><th>Current</th>"
        "<th>Query</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>"
    )


def render(a: analyze.Analysis, *, sources: list[str]) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    internal = sum(1 for d in a.documents if d.origin == "internal")
    external = len(a.documents) - internal
    positives = sum(1 for c in a.golden if c.kind == "positive")
    negatives = sum(1 for c in a.golden if c.kind == "negative")
    scope = sum(1 for c in a.golden if c.kind == "scope-negative")
    head_stats = (
        f'<div class="stats">'
        f'<div class="stat"><div class="n">{len(a.documents)}</div>'
        f'<div class="k">documents ({internal} internal · {external} crawled)</div></div>'
        f'<div class="stat"><div class="n">{positives}</div><div class="k">golden positives</div></div>'
        f'<div class="stat"><div class="n">{negatives + scope}</div>'
        f'<div class="k">negatives ({negatives} out-of-scope · {scope} uncovered)</div></div>'
        f'<div class="stat"><div class="n">{len(a.findings)}</div><div class="k">findings</div></div>'
        f"</div>"
    )
    read = "".join(f"<li class='mono'>{E(s)}</li>" for s in sources)
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>rag-lens · Octopus</title>"
        f"<style>{CSS}</style></head><body><div class='wrap'>"
        "<h1>rag-lens</h1>"
        "<p class='sub'>What the corpus covers, where retrieval sits against its own drop "
        f"threshold, and what a run moved. Generated {E(stamp)}.</p>"
        "<hr class='rule'>"
        f"{head_stats}"
        f"{render_findings(a)}"
        f"{render_coverage(a)}"
        f"{render_margins(a)}"
        f"{render_run(a)}"
        f"{render_documents(a)}"
        "<div class='foot'><h3>Read from</h3><ul style='padding-left:18px;margin:0'>"
        f"{read}</ul>"
        "<p style='margin-top:14px'>This page reports. It does not gate: the thresholds and "
        "the merge verdict live in <span class='mono'>octopus_ai.evaluation</span>, and a "
        "second implementation of the same arithmetic is a second thing that can disagree "
        "with CI.</p></div>"
        "</div></body></html>"
    )


# --- cli ---------------------------------------------------------------------


def _expand(patterns: list[str]) -> list[Path]:
    out: list[Path] = []
    for pattern in patterns:
        matched = [Path(p) for p in glob.glob(pattern)]
        if not matched and Path(pattern).is_file():
            matched = [Path(pattern)]
        out.extend(sorted(matched))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag-lens", description=__doc__)
    parser.add_argument("--out", default="rag-lens.html", help="output HTML path")
    parser.add_argument(
        "--current", nargs="*", default=[], help="shard JSON for the run to display"
    )
    parser.add_argument(
        "--baseline", nargs="*", default=[], help="shard JSON to diff the current run against"
    )
    parser.add_argument("--trace", default=None, help="rag-trace.json from probe.py")
    args = parser.parse_args(argv)

    root = data.find_repo_root(Path(__file__))
    current_paths = _expand(args.current)
    baseline_paths = _expand(args.baseline)
    trace_path = Path(args.trace) if args.trace else None

    if args.current and not current_paths:
        print(f"no shard files matched {args.current}", file=sys.stderr)
        return 2
    if args.baseline and not baseline_paths:
        print(f"no shard files matched {args.baseline}", file=sys.stderr)
        return 2
    if trace_path and not trace_path.is_file():
        print(f"no trace file at {trace_path}", file=sys.stderr)
        return 2

    documents = data.load_documents(root)
    if not documents:
        print("no corpus documents found; is this the Octopus repo?", file=sys.stderr)
        return 2

    a = analyze.analyse(
        documents=documents,
        stage_map=data.load_stage_map(root),
        golden=data.load_golden(root),
        current=data.load_shards(current_paths),
        baseline=data.load_shards(baseline_paths),
        trace=data.load_trace(trace_path),
    )

    sources = [
        "services/ai/corpus/*.md",
        "services/ai/eval/external/*.md",
        "docs/30-modules/rag-knowledge.md (stage coverage table)",
        "services/ai/eval/golden.json",
        *[str(p) for p in current_paths],
        *[f"{p} (baseline)" for p in baseline_paths],
        *([str(trace_path)] if trace_path else []),
    ]

    out = Path(args.out)
    out.write_text(render(a, sources=sources), encoding="utf-8")

    high = sum(1 for f in a.findings if f.severity == "high")
    print(f"wrote {out} · {len(a.documents)} documents · {len(a.findings)} findings", end="")
    print(f" ({high} high)" if high else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
