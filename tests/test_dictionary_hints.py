"""Existing-question hint completion: no live writes or real model requests."""

import argparse
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import dictionary_builder as builder
from tools import dictionary_audit as audit


class DictionaryHintsTests(unittest.TestCase):
    def fixture(self, folder):
        directory = Path(folder)
        concepts = [
            {"conceptId": "nature.mountain", "category": "nature", "labels": {"zh-Hans": "山"}},
            {"conceptId": "nature.forest", "category": "nature", "labels": {"zh-Hans": "森林"},
             "aliases": [{"lang": "zh-Hans", "text": "森林", "reviewStatus": "approved"}]},
            {"conceptId": "household.shampoo", "category": "household_items", "labels": {"zh-Hans": "洗发水"}},
            {"conceptId": "tech.appstore", "category": "technology", "labels": {"zh-Hans": "应用商店"}},
        ]
        base = {"schemaVersion": 1, "wordlistId": "test", "release": "2026-01-01",
                "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": concepts}
        base_path, review_path = directory / "base.json", directory / "review.json"
        builder.atomic_json(base_path, base)
        args = argparse.Namespace(base=base_path, review=review_path, count=20, batch_size=10,
            word_length="all", max_calls=10, timeout=2, blocklist=None, api_base="https://example.test/v1",
            model="hy3", allow_insecure_http=False, reasoning_effort="low", json_mode=True,
            diagnostics=directory / "diagnostics.jsonl")
        return args, base

    def response(self, *args, **kwargs):
        questions = json.loads(args[3])["questions"]
        self.assertEqual(kwargs["reasoning_effort"], "low")
        self.assertTrue(kwargs["json_mode"])
        self.assertGreaterEqual(args[8], 2400 + len(questions) * 220)
        return {"items": [{"word": q["word"], "hint": audit.SAFE_HINTS[q["category"]]} for q in questions]}

    def test_all_lengths_only_update_existing_questions_and_resume_without_key(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            original = args.base.read_bytes()
            with patch.object(builder, "get_api_key", return_value="test-secret"), \
                 patch.object(builder, "chat_completion", side_effect=self.response):
                builder.generate_hints(args)
            entries = builder.load_review(args.review)["entries"]
            self.assertEqual([len(e["word"]) for e in entries], [1, 2, 3, 4])
            self.assertTrue(all(e["action"] == "update_hint" and e["status"] == "pending" for e in entries))
            self.assertTrue(all("category" in e and "partOfSpeech" in e for e in entries))
            self.assertEqual(args.base.read_bytes(), original)
            with patch.object(builder, "get_api_key") as key, patch.object(builder, "chat_completion") as chat:
                builder.generate_hints(args)
                key.assert_not_called()
                chat.assert_not_called()
            self.assertFalse(builder.HAN_WORD.fullmatch("山"))  # No relaxation of new-question policy.
            self.assertEqual(builder.parser().parse_args(["generate-hints", "--review", "test.json", "--word-length", "1"]).word_length, "1")

    def test_range_validation_precedes_reading_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            with patch.object(builder, "get_api_key") as key:
                for field, value in [("count", 0), ("batch_size", 0), ("max_calls", 101), ("word_length", "5"), ("timeout", 0)]:
                    old = getattr(args, field)
                    setattr(args, field, value)
                    with self.assertRaisesRegex(ValueError, "补提示范围"):
                        builder.generate_hints(args)
                    setattr(args, field, old)
                key.assert_not_called()

    def test_alias_ownership_matches_game_and_ignores_unapproved_alias(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            base["concepts"].append({"conceptId": "other", "category": "nature", "labels": {"zh-Hans": "树林"},
                "isAnswerable": False, "status": "draft", "aliases": [
                    {"lang": "zh-Hans", "text": "森林", "reviewStatus": "approved"},
                    {"lang": "zh-Hans", "text": "山", "reviewStatus": "rejected"}]})
            builder.atomic_json(args.base, base)
            with patch.object(builder, "get_api_key", return_value="test-secret"), \
                 patch.object(builder, "chat_completion", side_effect=self.response):
                builder.generate_hints(args)
            self.assertEqual([e["word"] for e in builder.load_review(args.review)["entries"]], ["山", "洗发水", "应用商店"])

    def test_json_failure_adapts_and_retries_with_bounded_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            args.count = args.batch_size = 2
            sizes = []

            def chat(*call_args, **kwargs):
                sizes.append(len(json.loads(call_args[3])["questions"]))
                if len(sizes) == 1:
                    raise builder.ModelOutputError("模型输出达到 token 上限")
                return self.response(*call_args, **kwargs)

            with patch.object(builder, "get_api_key", return_value="test-secret"), patch.object(builder, "chat_completion", side_effect=chat):
                builder.generate_hints(args)
            self.assertEqual(sizes, [2, 1, 1])
            review = builder.load_review(args.review)
            self.assertEqual(len(review["entries"]), 2)
            self.assertEqual(review["hintRun"]["remainingWords"], [])

    def test_omitted_word_retried_three_times_then_saved_as_incomplete(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            args.count = 1
            with patch.object(builder, "get_api_key", return_value="test-secret"), \
                 patch.object(builder, "chat_completion", return_value={"items": []}) as chat:
                builder.generate_hints(args)
                self.assertEqual(chat.call_count, 3)
            review = builder.load_review(args.review)
            self.assertEqual(review["entries"], [])
            self.assertEqual(review["hintRun"]["remainingWords"], ["山"])

    def test_transport_failure_preserves_prior_pending_candidates(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            args.batch_size = 1
            count = 0

            def chat(*call_args, **kwargs):
                nonlocal count
                count += 1
                if count == 2:
                    raise RuntimeError("模型接口 HTTP 429")
                return self.response(*call_args, **kwargs)

            with patch.object(builder, "get_api_key", return_value="test-secret"), patch.object(builder, "chat_completion", side_effect=chat):
                with self.assertRaisesRegex(RuntimeError, "429"):
                    builder.generate_hints(args)
            review = builder.load_review(args.review)
            self.assertEqual([e["word"] for e in review["entries"]], ["山"])
            self.assertEqual(review["hintRun"]["remainingWords"], ["森林", "洗发水", "应用商店"])

    def test_invalid_duplicate_does_not_discard_later_valid_hint(self):
        with tempfile.TemporaryDirectory() as folder:
            args, base = self.fixture(folder)
            args.count = 1
            base["concepts"][0]["definitions"] = {"zh-Hans": " "}
            builder.atomic_json(args.base, base)
            with patch.object(builder, "get_api_key", return_value="test-secret"), patch.object(builder, "chat_completion",
                    return_value={"items": [{"word": "山", "hint": "山是一种自然事物"}, {"word": "山", "hint": "与自然世界有关的事物"}]}):
                builder.generate_hints(args)
            entry = builder.load_review(args.review)["entries"][0]
            self.assertEqual(entry["originalHint"], " ")
            self.assertEqual(entry["hint"], "与自然世界有关的事物")

    def test_single_character_aliases_cannot_be_disclosed(self):
        self.assertEqual(builder.validate_hint("森林", "林中常见的环境", aliases=("林",)), "提示直接包含答案或别名")
        self.assertIsNone(builder.validate_hint("森林", "与自然世界有关的事物", aliases=("",)))

    def test_single_character_hint_audit_uses_existing_metadata_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            entry = {"action": "update_hint", "conceptId": "nature.mountain", "word": "山", "hint": "自然界的一种地貌",
                     "originalHint": "", "status": "pending"}
            builder.atomic_json(args.review, {"schemaVersion": 1, "language": "zh-Hans", "entries": [entry, dict(entry)], "rejections": {}})
            audit_args = argparse.Namespace(**{**vars(args), "output": Path(folder) / "audited.json", "no_import": True,
                "admin_url": "http://127.0.0.1:3002", "model": audit.AUDIT_MODEL})

            def approve(*call_args, **kwargs):
                rows = json.loads(call_args[3])["entries"]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["category"], "nature")
                self.assertIsNone(rows[0]["partOfSpeech"])
                self.assertIn("允许原有的 1～4 字题目", call_args[6])
                return {"decisions": [{"index": rows[0]["index"], "verdict": "approve", "reason": "宽泛类别提示不泄露原题"}]}

            with patch.object(builder, "get_api_key", return_value="test-secret"), patch.object(builder, "chat_completion", side_effect=approve):
                audit.audit_and_publish(audit_args)
            self.assertEqual([e["status"] for e in builder.load_review(args.review)["entries"]], ["approved", "rejected"])
            snapshot = builder.load_snapshot(audit_args.output)
            self.assertEqual(len(snapshot["concepts"]), 4)
            self.assertEqual(snapshot["concepts"][0]["definitions"]["zh-Hans"], "与自然世界有关的事物")

    def test_replacing_old_approved_hint_requires_fresh_model_review(self):
        with tempfile.TemporaryDirectory() as folder:
            args, _ = self.fixture(folder)
            entry = {"action": "update_hint", "conceptId": "nature.mountain", "word": "山", "hint": "自然界的一种地貌",
                     "originalHint": "", "status": "approved", "auditModel": audit.AUDIT_MODEL}
            entry["auditFingerprint"] = audit.fingerprint(entry)
            builder.atomic_json(args.review, {"schemaVersion": 1, "language": "zh-Hans", "entries": [entry], "rejections": {}})
            audit_args = argparse.Namespace(**{**vars(args), "output": Path(folder) / "audited.json", "no_import": True,
                "admin_url": "http://127.0.0.1:3002", "model": audit.AUDIT_MODEL})
            with patch.object(builder, "get_api_key", return_value="test-secret"), \
                 patch.object(builder, "chat_completion", side_effect=RuntimeError("模型接口 HTTP 503")) as chat:
                with self.assertRaisesRegex(RuntimeError, "503"):
                    audit.audit_and_publish(audit_args)
                chat.assert_called_once()
            changed = builder.load_review(args.review)["entries"][0]
            self.assertEqual(changed["status"], "pending")
            self.assertEqual(changed["generatedHint"], "自然界的一种地貌")
            self.assertFalse(audit_args.output.exists())

    def test_broad_templates_for_answers_named_after_categories_do_not_leak(self):
        for word, hint in audit.SAFE_HINT_OVERRIDES.items():
            self.assertIsNone(builder.validate_hint(word, hint), word)

    def test_corrected_existing_hint_retries_once_but_safety_and_uncommon_rejects_stay(self):
        review = {"entries": [
            {"word": "梦想", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "归为心情感受事物不够准确"},
            {"word": "学习", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "提示与词性不符"},
            {"word": "餐食", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "非日常常用词且提示不准确"},
            {"word": "钱", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "提示涉及隐私安全"},
            {"word": "颜色", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "归入日常文化事物不自然，提示与词义不符"},
            {"word": "晚餐", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "晚餐是餐次不是一种食物"},
            {"word": "咖啡", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "咖啡通常指饮品，说成一种食物不准确且可能误导"},
            {"word": "工作", "action": "update_hint", "status": "rejected", "auditModel": audit.AUDIT_MODEL,
             "auditReason": "提示涉及赌博"},
        ]}
        self.assertEqual(audit.retry_corrected_hint_rejections(review, audit.AUDIT_MODEL), 5)
        self.assertEqual([e["status"] for e in review["entries"]], ["pending", "pending", "rejected", "rejected", "pending", "pending", "pending", "rejected"])
        review["entries"][0]["status"] = "rejected"
        self.assertEqual(audit.retry_corrected_hint_rejections(review, audit.AUDIT_MODEL), 0)


if __name__ == "__main__":
    unittest.main()
