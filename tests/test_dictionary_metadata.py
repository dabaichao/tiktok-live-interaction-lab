"""Metadata-only migration tests: synthetic models and temporary data, no live writes."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import dictionary_builder as builder
from tools import dictionary_metadata as metadata


class DictionaryMetadataTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder)
        base = {"schemaVersion": 1, "wordlistId": "test", "defaultLanguage": "zh-Hans",
            "languages": ["zh-Hans", "en"], "release": "2026-01-01", "concepts": [
                {"conceptId": "mountain", "senseKey": "mountain", "category": "nature",
                 "labels": {"zh-Hans": "山", "en": "mountain"}, "definitions": {"zh-Hans": "自然中的事物"}},
                {"conceptId": "learn", "senseKey": "learn", "category": "work",
                 "labels": {"zh-Hans": "学习", "en": "learn"}, "partOfSpeech": {"en": "verb"},
                 "aliases": [{"lang": "zh-Hans", "text": "学习", "reviewStatus": "approved"}]},
                {"conceptId": "happy", "senseKey": "happy", "category": "emotion",
                 "labels": {"zh-Hans": "开心", "en": "happy"}},
                {"conceptId": "apple", "category": "food", "labels": {"zh-Hans": "苹果"},
                 "partOfSpeech": {"zh-Hans": "名词"}},
                {"conceptId": "guess", "labels": {"zh-Hans": "高山"}, "isAnswerable": False},
            ]}
        args = argparse.Namespace(base=root / "base.json", review=root / "metadata-review.json",
            output=root / "output.json", skip_words=set(), batch_size=2, max_calls=10, timeout=2,
            api_base="https://example.test/v1", diagnostics=root / "diagnostics.jsonl", allow_insecure_http=False)
        builder.atomic_json(args.base, base)
        return args, base

    def generate_response(self, *args, **kwargs):
        self.assertEqual(args[2], "hy3")
        self.assertEqual(kwargs["reasoning_effort"], "low")
        self.assertTrue(kwargs["json_mode"])
        qs = json.loads(args[3])["questions"]
        self.assertTrue(all(q["originalPartOfSpeech"] is None for q in qs))
        positions = {"mountain": "名词", "learn": "动词", "happy": "形容词"}
        return {"items": [{"conceptId": q["conceptId"], "word": q["word"],
                           "partOfSpeech": positions[q["conceptId"]], "reason": "符合原义项"} for q in qs]}

    def audit_response(self, *args, **kwargs):
        self.assertEqual(args[2], metadata.AUDIT_MODEL)
        self.assertNotEqual(args[2], "hy3")
        self.assertTrue(kwargs["json_mode"])
        rows = json.loads(args[3])["entries"]
        self.assertNotIn("reason", rows[0])  # Independent reviewer does not copy the generator's justification.
        return {"decisions": [{"index": row["index"], "verdict": "approve", "reason": "独立检查符合词义"} for row in rows]}

    def generate_fixture(self, args):
        with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                patch.object(builder, "chat_completion", side_effect=self.generate_response):
            metadata.generate(args)

    def audit_fixture(self, args):
        with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                patch.object(builder, "chat_completion", side_effect=self.audit_response):
            metadata.review_metadata(args)

    def test_metadata_only_migration_preserves_all_other_concept_fields(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            original = args.base.read_bytes()
            self.generate_fixture(args)
            self.assertFalse(args.output.exists())
            self.audit_fixture(args)
            metadata.publish(args)
            output = builder.load_snapshot(args.output)
            stripped = deepcopy(output["concepts"])
            for c in stripped:
                if c["conceptId"] in ("mountain", "happy"):
                    c.pop("partOfSpeech")
                if c["conceptId"] == "learn":
                    del c["partOfSpeech"]["zh-Hans"]
            self.assertEqual(stripped, base["concepts"])
            self.assertEqual(args.base.read_bytes(), original)
            self.assertEqual(output["concepts"][1]["partOfSpeech"], {"en": "verb", "zh-Hans": "动词"})
            self.assertEqual([e["status"] for e in metadata.load(args)[1]["entries"]], ["approved"] * 3)

    def test_resume_completed_generation_and_review_never_reads_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            self.generate_fixture(args)
            self.audit_fixture(args)
            with patch.object(metadata, "client") as client, patch.object(builder, "chat_completion") as chat:
                metadata.generate(args)
                metadata.review_metadata(args)
                client.assert_not_called()
                chat.assert_not_called()

    def test_ambiguous_alias_draft_existing_pos_and_explicit_skip_are_not_inferred(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            base["concepts"].append({"conceptId": "other", "labels": {"zh-Hans": "别词"}, "status": "draft",
                "aliases": [{"lang": "zh-Hans", "text": "山", "reviewStatus": "approved"},
                            {"lang": "zh-Hans", "text": "学习", "reviewStatus": "rejected"}]})
            base["concepts"][2]["partOfSpeech"] = {"zh-Hans": "    "}
            self.assertEqual(set(metadata.eligible(base)), {"learn", "happy"})
            self.assertEqual(set(metadata.eligible(base, {"开心"})), {"learn"})

    def test_incomplete_responses_split_and_preserve_every_previous_batch(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            sizes = []

            def chat(*a, **kw):
                sizes.append(len(json.loads(a[3])["questions"]))
                return {"items": []} if len(sizes) == 1 else self.generate_response(*a, **kw)

            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", side_effect=chat):
                metadata.generate(args)
            self.assertEqual(sizes, [2, 1, 1, 1])
            self.assertEqual(metadata.load(args)[1]["run"]["remainingGeneration"], [])

    def test_single_invalid_response_and_budget_stop_without_approval(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            args.batch_size = 1
            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", return_value={"items": []}) as chat:
                with self.assertRaisesRegex(RuntimeError, "单条"):
                    metadata.generate(args)
                self.assertEqual(chat.call_count, 1)
            self.assertEqual(metadata.load(args)[1]["entries"], [])
            args.max_calls = 1
            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", side_effect=self.generate_response):
                with self.assertRaisesRegex(RuntimeError, "上限"):
                    metadata.generate(args)
            self.assertEqual(metadata.load(args)[1]["run"]["remainingGeneration"], ["学习", "开心"])

    def test_model_failure_preserves_progress_and_never_publishes(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            self.generate_fixture(args)
            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", side_effect=RuntimeError("模型接口 HTTP 429")):
                with self.assertRaisesRegex(RuntimeError, "429"):
                    metadata.review_metadata(args)
            with self.assertRaisesRegex(ValueError, "待审核"):
                metadata.publish(args)
            self.assertFalse(args.output.exists())

    def test_uncertain_and_rejected_never_auto_retry_or_publish_as_approved(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)

            def generate_uncertain(*a, **kw):
                r = self.generate_response(*a, **kw)
                for row in r["items"]:
                    if row["conceptId"] == "happy":
                        row["partOfSpeech"] = None
                        row["reason"] = "此义项待人工确认"
                return r

            def reject_learning(*a, **kw):
                r = self.audit_response(*a, **kw)
                for decision in r["decisions"]:
                    if decision["index"] == 1:
                        decision["verdict"] = "reject"
                return r

            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", side_effect=generate_uncertain):
                metadata.generate(args)
            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", side_effect=reject_learning):
                metadata.review_metadata(args)
            metadata.publish(args)
            output = builder.load_snapshot(args.output)
            self.assertEqual(output["concepts"][0]["partOfSpeech"]["zh-Hans"], "名词")
            self.assertNotIn("zh-Hans", output["concepts"][1]["partOfSpeech"])
            self.assertNotIn("partOfSpeech", output["concepts"][2])
            with patch.object(metadata, "client") as client:
                metadata.generate(args)
                metadata.review_metadata(args)
                client.assert_not_called()

    def test_changed_candidate_or_base_cannot_reuse_approval(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            self.generate_fixture(args)
            self.audit_fixture(args)
            review = metadata.load(args)[1]
            review["entries"][0]["partOfSpeech"] = "动词"
            builder.atomic_json(args.review, review)
            with self.assertRaisesRegex(ValueError, "指纹"):
                metadata.publish(args)
            with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                    patch.object(builder, "chat_completion", side_effect=RuntimeError("审核不可用")):
                with self.assertRaises(RuntimeError):
                    metadata.review_metadata(args)
            self.assertEqual(metadata.load(args)[1]["entries"][0]["status"], "pending")
            base["concepts"][0]["labels"]["zh-Hans"] = "峰"
            builder.atomic_json(args.base, base)
            with self.assertRaisesRegex(ValueError, "基础包已改变"):
                metadata.publish(args)

    def test_rejects_duplicate_identifier_missing_pos_and_unknown_output_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            duplicate = deepcopy(base)
            duplicate["concepts"].append(duplicate["concepts"][0])
            with self.assertRaisesRegex(ValueError, "重复"):
                metadata.eligible(duplicate)
            args.batch_size = 1
            for change in (lambda r: r.pop("partOfSpeech"), lambda r: r.update(conceptId="intruder"),
                           lambda r: r.update(partOfSpeech={"bad": True})):
                def chat(*a, **kw):
                    r = self.generate_response(*a, **kw)
                    change(r["items"][0])
                    return r
                with patch.object(metadata, "client", return_value=(args.api_base, "test-secret")), \
                        patch.object(builder, "chat_completion", side_effect=chat):
                    with self.assertRaisesRegex(RuntimeError, "单条"):
                        metadata.generate(args)

    def test_bounds_empty_plan_and_output_overwrite_do_not_read_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            with patch.object(metadata, "client") as client:
                args.skip_words = {"山", "学习", "开心"}
                metadata.generate(args)
                metadata.review_metadata(args)
                for field, bad in [("batch_size", 0), ("max_calls", 101), ("timeout", float("nan"))]:
                    old = getattr(args, field)
                    setattr(args, field, bad)
                    with self.assertRaisesRegex(ValueError, "词性范围"):
                        metadata.generate(args)
                    setattr(args, field, old)
                client.assert_not_called()
            builder.atomic_json(args.output, base)
            with self.assertRaisesRegex(ValueError, "独立文件"):
                metadata.publish(args)

    def test_null_source_pos_is_missing_not_a_publish_crash(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            base["concepts"][0]["partOfSpeech"] = None
            builder.atomic_json(args.base, base)
            self.generate_fixture(args)
            self.audit_fixture(args)
            metadata.publish(args)
            self.assertEqual(builder.load_snapshot(args.output)["concepts"][0]["partOfSpeech"], {"zh-Hans": "名词"})
            base["concepts"][0]["partOfSpeech"] = "invalid"
            with self.assertRaisesRegex(ValueError, "词性字段"):
                metadata.eligible(base)

    def test_corrupt_review_cannot_reach_a_model_or_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            self.generate_fixture(args)
            original = metadata.load(args)[1]
            for invalid_id in ([], None, ""):
                review = deepcopy(original)
                review["entries"][0]["conceptId"] = invalid_id
                builder.atomic_json(args.review, review)
                with patch.object(metadata, "client") as client:
                    with self.assertRaisesRegex(ValueError, "概念ID"):
                        metadata.review_metadata(args)
                    client.assert_not_called()

    def test_old_single_question_generator_does_not_invent_a_noun(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            base["concepts"] = [{"conceptId": "learn", "labels": {"zh-Hans": "学习"}, "category": "work"}]
            builder.atomic_json(args.base, base)
            single = argparse.Namespace(**{**vars(args), "answer": "学习", "count": 1, "max_calls": 1,
                "topics_file": None, "blocklist": None, "model": "hy3", "interactive": False})
            response = {"items": [{"word": "学习", "role": "answer", "category": "work", "partOfSpeech": "动词",
                "hint": "与知识或技能有关的活动"}, {"word": "练习", "role": "guess", "category": "work",
                "partOfSpeech": "动词", "hint": ""}]}
            with patch.object(builder, "get_api_key", return_value="test-secret"), \
                    patch.object(builder, "chat_completion", return_value=response) as chat:
                builder.generate_for_answer(single)
            self.assertIsNone(json.loads(chat.call_args.args[3])["answerPartOfSpeech"])


if __name__ == "__main__":
    unittest.main()
