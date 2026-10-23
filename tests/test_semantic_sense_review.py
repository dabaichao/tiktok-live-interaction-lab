"""No credentials/network: independent prompts, immutable sources and resume checks."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import dictionary_builder as builder
from tools import semantic_sense_review as sense


class SemanticSenseTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder)
        args = argparse.Namespace(base=root / "base.json", baseline=root / "baseline.json",
            review=root / "review.json", command="generate", answers=["彩虹"], batch_size=4,
            timeout=2, diagnostics=None, allow_insecure_http=False)
        snapshot = {"schemaVersion": 1, "wordlistId": "test", "defaultLanguage": "zh-Hans",
            "concepts": [{"conceptId": "rainbow", "labels": {"zh-Hans": "彩虹", "en": "rainbow"},
                          "category": "nature", "senseKey": "rainbow", "definitions": {"zh-Hans": "与自然世界有关的事物"}}]}
        scores = [{"guess": w, "relation": relation, "guardedScore": 999.1} for relation, words in
            [("related", ["七彩", "雨后", "光谱"]), ("unrelated", ["键盘", "枕头", "地铁"])] for w in words]
        builder.atomic_json(args.base, snapshot)
        builder.atomic_json(args.baseline, {"realEmbeddings": True, "labelFingerprint": "a" * 64,
                                         "results": [{"answer": "彩虹", "scores": scores}]})
        return args

    def response(self, *a, **kw):
        qs = json.loads(a[3])["questions"]
        self.assertNotIn("999.1", a[3])
        self.assertNotIn('"related"', a[3])
        self.assertNotIn('"unrelated"', a[3])
        self.assertTrue(kw["json_mode"])
        rows = []
        for q in qs:
            row = {"conceptId": q["conceptId"], "word": q["word"]}
            if a[6] == sense.GENERATE_PROMPT:
                self.assertEqual(a[2], "hy3")
                self.assertNotIn("probes", q)
                row["definition"] = "阳光经过空气中的水滴后呈现的弧形多色光带"
            elif a[6] == sense.SENSE_PROMPT:
                self.assertEqual(a[2], sense.REVIEWER)
                self.assertNotIn("probes", q)
                row.update(verdict="approve", reason="原义项的准确说明")
            else:
                self.assertEqual(a[2], sense.REVIEWER)
                self.assertNotIn("proposedDefinition", q)
                self.assertNotEqual(q["probes"], ["七彩", "雨后", "光谱", "键盘", "枕头", "地铁"])
                row["probes"] = [{"word": w, "relation": "direct" if w in ("七彩", "雨后", "光谱") else "unrelated",
                                  "reason": "独立关系核查"} for w in q["probes"]]
            rows.append(row)
        return {"items": rows}

    def execute(self, args):
        with patch.object(sense, "client", return_value=("https://example.test/v1", "test-key")), \
                patch.object(builder, "chat_completion", side_effect=self.response):
            sense.run(args)

    def test_three_separate_prompts_never_disclose_labels_scores_or_candidates_to_relation_reviewer(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            original = [args.base.read_bytes(), args.baseline.read_bytes()]
            for command in ("generate", "relations", "audit"):
                args.command = command
                self.execute(args)
            review, _, _ = sense.load(args)
            self.assertEqual(review["senses"][0]["verdict"], "approve")
            self.assertFalse(review["productionChanged"])
            self.assertFalse(review["relations"][0]["expectedLabelsDisclosed"])
            self.assertEqual(original, [args.base.read_bytes(), args.baseline.read_bytes()])
            self.assertEqual(len(list(Path(f).glob("*.json"))), 3)

    def test_completed_resume_reads_no_credentials_and_calls_no_model(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            for command in ("generate", "audit", "relations"):
                args.command = command
                self.execute(args)
            with patch.object(sense, "client") as client, patch.object(builder, "chat_completion") as chat:
                for command in ("generate", "audit", "relations"):
                    args.command = command
                    sense.run(args)
                client.assert_not_called()
                chat.assert_not_called()

    def test_changed_source_or_candidate_cannot_reuse_review(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            self.execute(args)
            args.command = "audit"
            self.execute(args)
            review = json.loads(args.review.read_text(encoding="utf8"))
            review["senses"][0]["definition"] += "新的未审语义"
            builder.atomic_json(args.review, review)
            with patch.object(sense, "client") as client:
                with self.assertRaisesRegex(ValueError, "候选变化"):
                    sense.run(args)
                client.assert_not_called()
            args.base.write_bytes(args.base.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "变化"):
                sense.load(args)

    def test_null_and_rejection_do_not_generate_retries_or_approval(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            with patch.object(sense, "client", return_value=("https://example.test", "key")), \
                    patch.object(builder, "chat_completion", return_value={"items": [
                        {"conceptId": "rainbow", "word": "彩虹", "definition": None}]}):
                sense.run(args)
            args.command = "audit"
            with patch.object(sense, "client") as client:
                sense.run(args)
                client.assert_not_called()
            self.assertIsNone(sense.load(args)[0]["senses"][0]["definition"])

    def test_incomplete_batch_stops_and_retains_pending_evidence(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            with patch.object(sense, "client", return_value=("https://example.test", "key")), \
                    patch.object(builder, "chat_completion", return_value={"items": []}) as chat:
                with self.assertRaisesRegex(ValueError, "漏项"):
                    sense.run(args)
                self.assertEqual(chat.call_count, 1)
            self.assertEqual(sense.load(args)[0]["senses"], [])

    def test_invalid_bounds_duplicate_or_overwrite_rejected_before_credentials(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            with patch.object(sense, "client") as client:
                args.timeout = float("nan")
                with self.assertRaises(ValueError):
                    sense.run(args)
                args.timeout = 2
                args.answers *= 2
                with self.assertRaisesRegex(ValueError, "不同题目"):
                    sense.run(args)
                args.answers = ["彩虹"]
                args.review = args.base
                with self.assertRaisesRegex(ValueError, "覆盖"):
                    sense.run(args)
                client.assert_not_called()

    def test_relation_duplicate_or_unknown_word_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            args.command = "relations"
            def bad(*a, **kw):
                result = self.response(*a, **kw)
                result["items"][0]["probes"][0]["word"] = "彩虹"
                return result
            with patch.object(sense, "client", return_value=("https://example.test", "key")), \
                    patch.object(builder, "chat_completion", side_effect=bad):
                with self.assertRaisesRegex(ValueError, "漏词或换词"):
                    sense.run(args)
            self.assertEqual(sense.load(args)[0]["relations"], [])

    def test_canonical_hash_is_unicode_and_key_order_stable(self):
        self.assertEqual(sense.digest({"b": "彩虹", "a": None}),
                         hashlib.sha256('{"a":null,"b":"彩虹"}'.encode("utf8")).hexdigest())

    def test_approved_alias_on_another_concept_prevents_paid_ambiguous_generation(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            base = builder.load_snapshot(args.base)
            base["concepts"].append({"conceptId": "other", "labels": {"zh-Hans": "别词"},
                "isAnswerable": False, "aliases": [{"lang": "zh-Hans", "text": "彩虹", "reviewStatus": "approved"}]})
            builder.atomic_json(args.base, base)
            with patch.object(sense, "client") as client:
                with self.assertRaisesRegex(ValueError, "唯一对应"):
                    sense.run(args)
                client.assert_not_called()

    def test_diagnostic_cannot_overwrite_sources(self):
        with tempfile.TemporaryDirectory() as f:
            args = self.fixture(f)
            args.diagnostics = args.baseline
            with patch.object(sense, "client") as client:
                with self.assertRaisesRegex(ValueError, "诊断日志不能覆盖"):
                    sense.run(args)
                client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
