"""Tests for rag-lens.

Run with the repo's own Python; there is nothing to install:

    python -m pytest tools/rag-lens/test_rag_lens.py -q

Two things are worth testing here and the rest is presentation. First, that the
stage map is really *parsed* from rag-knowledge.md rather than quietly falling
back to something hardcoded, because the moment it stops parsing, the coverage
grid starts reporting a corpus that no longer exists. Second, that each finding
fires on the disagreement it names and stays quiet otherwise: a report that cries
drift on a healthy repo is one people stop reading, which costs more than not
having built it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import lens_analyze as analyze  # noqa: E402
import lens_data as data  # noqa: E402
import rag_lens  # noqa: E402

ROOT = data.find_repo_root(Path(__file__))


def doc(slug: str, *, title: str | None = None, market: str = "US", origin: str = "internal"):
    return data.Document(
        slug=slug,
        title=title or slug.replace("-", " ").title(),
        origin=origin,
        market=market,
        doc_type="playbook",
        authority="internal",
        source_url=None,
        effective_date=None,
        words=500,
    )


def case(case_id: str, expect: list[str], kind: str = "positive"):
    return data.GoldenCase(id=case_id, query=f"q {case_id}", expect_docs=expect, notes=None, kind=kind)


def run(**over):
    base = dict(documents=[], stage_map={}, golden=[], current={}, baseline={}, trace=None)
    base.update(over)
    return analyze.analyse(**base)


def kinds(a) -> set[str]:
    return {f.kind for f in a.findings}


# --- reading the real repo ----------------------------------------------------


class TestAgainstTheRealRepo:
    def test_stage_map_parses_from_the_module_doc(self):
        """If this returns nothing, every coverage cell silently reads empty."""
        stages = data.load_stage_map(ROOT)
        assert stages, "the Stage/Documents table in rag-knowledge.md did not parse"
        assert "Strategy" in stages and "Measurement" in stages
        # Slugs, not prose: the table renders documents in backticks and the grid
        # joins on the filename.
        assert all(
            all("`" not in slug and " " not in slug for slug in slugs)
            for slugs in stages.values()
        )

    def test_documents_load_from_both_corpus_directories(self):
        docs = data.load_documents(ROOT)
        origins = {d.origin for d in docs}
        assert origins == {"internal", "external"}, (
            "seed.py ingests corpus/ and eval/external/; reporting one of them "
            "under-counts the corpus retrieval actually searches"
        )
        assert all(d.title for d in docs)

    def test_golden_keeps_the_two_negative_kinds_apart(self):
        golden = data.load_golden(ROOT)
        kinds_seen = {c.kind for c in golden}
        assert kinds_seen == {"positive", "negative", "scope-negative"}, (
            "out-of-scope negatives are a retrieval property and scope negatives "
            "are a gate property; collapsing them misreports one as the other"
        )

    def test_report_renders_end_to_end_with_no_run_supplied(self, tmp_path):
        out = tmp_path / "r.html"
        assert rag_lens.main(["--out", str(out)]) == 0
        html = out.read_text(encoding="utf-8")
        assert "<title>rag-lens" in html
        assert "Coverage" in html and "Findings" in html
        # Self-contained: no network at view time.
        assert "http://" not in html.replace("http://www.w3.org", "")
        assert "<script" not in html


# --- findings fire on the disagreement they name ------------------------------


class TestFindings:
    def test_quiet_when_everything_agrees(self):
        d = doc("alpha")
        a = run(
            documents=[d],
            stage_map={"Strategy": ["alpha"]},
            golden=[case("c1", [d.title])],
        )
        assert a.findings == []

    def test_stage_naming_a_missing_document_is_high(self):
        a = run(documents=[doc("alpha")], stage_map={"Strategy": ["alpha", "ghost"]},
                golden=[case("c1", ["Alpha"])])
        f = next(f for f in a.findings if f.subject == "ghost")
        assert f.severity == "high"
        assert "stage map names a missing document" == f.kind

    def test_golden_case_expecting_a_missing_title_is_high(self):
        """Cases are keyed on title, so a rename breaks them silently."""
        a = run(documents=[doc("alpha")], stage_map={"Strategy": ["alpha"]},
                golden=[case("c1", ["Alpha"]), case("c2", ["Renamed Away"])])
        f = next(f for f in a.findings if f.subject == "c2")
        assert f.severity == "high"

    def test_document_no_golden_case_asks_for(self):
        a = run(documents=[doc("alpha"), doc("beta")],
                stage_map={"Strategy": ["alpha", "beta"]},
                golden=[case("c1", ["Alpha"])])
        assert "document unproven by the golden set" in kinds(a)
        assert any(f.subject == "beta" for f in a.findings)

    def test_unmapped_document_still_appears_on_the_grid(self):
        """A crawled page belongs to no funnel stage and must not vanish."""
        a = run(documents=[doc("alpha"), doc("crawled", origin="external")],
                stage_map={"Strategy": ["alpha"]},
                golden=[case("c1", ["Alpha"]), case("c2", ["Crawled"])])
        assert analyze.UNSTAGED in a.stages
        pen = a.cell(analyze.UNSTAGED, "US")
        assert [d.slug for d in pen.docs] == ["crawled"]
        assert "document not mapped to a stage" in kinds(a)

    def test_market_with_documents_but_no_funnel_coverage(self):
        a = run(
            documents=[doc("alpha"), doc("uk-only", market="UK", origin="external")],
            stage_map={"Strategy": ["alpha"]},
            golden=[case("c1", ["Alpha"]), case("c2", ["Uk Only"])],
        )
        f = next(f for f in a.findings if f.subject == "UK")
        assert f.severity == "medium"
        assert "covers no funnel stage" in f.kind

    def test_partial_market_coverage_lists_the_blank_stages(self):
        a = run(
            documents=[doc("alpha"), doc("beta", market="UK")],
            stage_map={"Strategy": ["alpha"], "Content": ["beta"]},
            golden=[case("c1", ["Alpha"]), case("c2", ["Beta"])],
        )
        uk = next(f for f in a.findings if f.subject == "UK")
        assert "Strategy" in uk.detail
        us = next(f for f in a.findings if f.subject == "US")
        assert "Content" in us.detail


class TestMeasuredFindings:
    def _result(self, **over):
        base = dict(id="c1", query="q", expect_docs=["Alpha"], retrieved_titles=["Alpha"],
                    top_score=0.5, candidates=25, dropped=20)
        base.update(over)
        return data.CaseResult(**base)

    def _run(self, result, trace=None):
        return run(
            documents=[doc("alpha")],
            stage_map={"Strategy": ["alpha"]},
            golden=[case("c1", ["Alpha"])],
            current={result.id: result},
            trace=trace,
        )

    def test_a_leak_is_high(self):
        a = self._run(self._result(expect_docs=[], retrieved_titles=["Alpha"]))
        f = next(f for f in a.findings if f.kind == "negative case leaked")
        assert f.severity == "high"

    def test_a_clean_negative_reports_nothing(self):
        a = self._run(self._result(expect_docs=[], retrieved_titles=[], top_score=None))
        assert "negative case leaked" not in kinds(a)

    def test_a_miss_is_medium(self):
        a = self._run(self._result(retrieved_titles=["Something Else"]))
        assert "positive case missed" in kinds(a)

    def test_a_deep_rank_is_reported_even_though_it_hit(self):
        a = self._run(
            self._result(retrieved_titles=["X", "Y", "Z", "Alpha"])
        )
        f = next(f for f in a.findings if f.kind == "expected document ranked deep")
        assert "rank 4" in f.detail

    def test_thin_margin_needs_a_threshold_and_fires_under_the_ratio(self):
        trace = data.TraceFile(settings={"rerank_min_score": 0.0013}, probes=[])
        thin = self._run(self._result(top_score=0.0013 * 1.76), trace=trace)
        assert "thin margin over the threshold" in kinds(thin)
        wide = self._run(self._result(top_score=0.0013 * 14.0), trace=trace)
        assert "thin margin over the threshold" not in kinds(wide)

    def test_no_threshold_means_no_margin_claim(self):
        """Without a trace there is no threshold, and guessing one would be a lie."""
        a = self._run(self._result(top_score=0.0001))
        assert "thin margin over the threshold" not in kinds(a)

    def test_proven_marks_the_cell_only_when_a_case_actually_hit(self):
        hit = self._run(self._result())
        assert hit.cell("Strategy", "US").proven is True
        missed = self._run(self._result(retrieved_titles=["Other"]))
        assert missed.cell("Strategy", "US").proven is False


# --- run diff -----------------------------------------------------------------


class TestDiff:
    def r(self, case_id, titles, expect=("Alpha",)):
        return data.CaseResult(
            id=case_id, query="q", expect_docs=list(expect), retrieved_titles=list(titles),
            top_score=0.5, candidates=25, dropped=20,
        )

    def test_regression_fix_and_stability_are_distinguished(self):
        before = {"a": self.r("a", ["Alpha"]), "b": self.r("b", []), "c": self.r("c", ["Alpha"])}
        after = {"a": self.r("a", []), "b": self.r("b", ["Alpha"]), "c": self.r("c", ["Alpha"])}
        status = {d.id: d.status for d in analyze.diff(before, after)}
        assert status == {"a": "regressed", "b": "fixed", "c": "same"}

    def test_regressions_sort_first(self):
        before = {"z": self.r("z", []), "a": self.r("a", ["Alpha"])}
        after = {"z": self.r("z", ["Alpha"]), "a": self.r("a", [])}
        assert [d.id for d in analyze.diff(before, after)] == ["a", "z"]

    def test_added_and_removed_cases_are_not_silently_dropped(self):
        status = {
            d.id: d.status
            for d in analyze.diff({"old": self.r("old", ["Alpha"])}, {"new": self.r("new", ["Alpha"])})
        }
        assert status == {"old": "gone", "new": "new"}

    def test_a_rank_change_that_keeps_the_hit_is_only_a_move(self):
        before = {"a": self.r("a", ["Alpha", "X"])}
        after = {"a": self.r("a", ["X", "Alpha"])}
        assert analyze.diff(before, after)[0].status == "moved"


# --- shard loading ------------------------------------------------------------


def test_shards_merge_on_case_id(tmp_path):
    def write(name, ids):
        (tmp_path / name).write_text(
            json.dumps({"results": [
                {"id": i, "query": "q", "expect_docs": ["A"], "retrieved_titles": ["A"],
                 "top_score": 0.5, "candidates": 20, "dropped": 15} for i in ids]}),
            encoding="utf-8",
        )
    write("s0.json", ["a", "b"])
    write("s1.json", ["c"])
    merged = data.load_shards([tmp_path / "s0.json", tmp_path / "s1.json"])
    assert set(merged) == {"a", "b", "c"}


def test_missing_shard_glob_fails_loudly(tmp_path, capsys):
    """A typo'd glob must not render a report that looks like a clean run."""
    code = rag_lens.main(["--out", str(tmp_path / "r.html"), "--current", str(tmp_path / "nope-*.json")])
    assert code == 2
    assert "no shard files matched" in capsys.readouterr().err


def test_margin_ratio_is_the_headline_number():
    p = data.Probe(query="q", subqueries=[], threshold=0.0013, kept=1, dropped=9,
                   scored=[{"rerank_score": 0.0013 * 1.76, "title": "T", "kept": True}])
    assert p.margin == pytest.approx(1.76)
