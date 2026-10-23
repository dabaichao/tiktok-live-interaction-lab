"""Run with: python -m unittest discover -s tests -p test_dictionary_audit.py"""

import argparse
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tools import dictionary_audit as audit
from tools import dictionary_builder as builder


class DictionaryAuditTests(unittest.TestCase):
    def fixture(self, directory: Path):
        base, review = directory / "base.json", directory / "review.json"
        builder.atomic_json(base, {"schemaVersion": 1, "wordlistId": "test", "release": "2026-01-01",
                                   "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
        builder.atomic_json(review, {"schemaVersion": 1, "language": "zh-Hans", "entries": [
            {"word": "生日", "role": "answer", "category": "culture", "partOfSpeech": "名词",
             "hint": "生活中的一种纪念日", "status": "pending"},
            {"word": "蛋糕", "role": "guess", "category": "food", "partOfSpeech": "名词", "hint": "",
             "sourceAnswer": "生日", "relationLevel": "near", "status": "pending"},
            {"word": "蛋糕", "role": "guess", "category": "food", "partOfSpeech": "名词", "hint": "",
             "sourceAnswer": "生日", "relationLevel": "near", "status": "pending"},
            {"word": "彩虹", "role": "answer", "category": "nature", "partOfSpeech": "名词",
             "hint": "雨后天空中出现的彩色弧线", "status": "pending"},
            {"word": "光谱", "role": "guess", "category": "nature", "partOfSpeech": "名词", "hint": "",
             "sourceAnswer": "彩虹", "relationLevel": "near", "status": "pending"},
        ], "rejections": {}})
        args = argparse.Namespace(base=base, review=review, output=directory / "audited.json",
                                  blocklist=None, batch_size=12, model=audit.AUDIT_MODEL,
                                  api_base="https://example.test/v1", timeout=2,
                                  diagnostics=directory / "diagnostics.jsonl", admin_url="http://127.0.0.1:3002",
                                  no_import=False, allow_insecure_http=False)
        return args

    def test_batch_review_deduplicates_publishes_and_imports_only_approved(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.fixture(Path(folder))
            seen_indices = []

            def fake_chat(*call_args, **kwargs):
                rows = json.loads(call_args[3])["entries"]
                seen_indices.extend(row["index"] for row in rows)
                self.assertEqual(call_args[2], "deepseek-v4.1-flash")
                self.assertTrue(kwargs["json_mode"])
                self.assertTrue(all(row["hint"] == audit.SAFE_HINTS["culture"] for row in rows if row["word"] == "生日"))
                return {"decisions": [{"index": row["index"], "verdict": "reject" if row["word"] == "彩虹" else "approve",
                                       "reason": "提示过于具体" if row["word"] == "彩虹" else "词义稳定且线索合适"} for row in rows]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), \
                 patch.object(builder, "chat_completion", side_effect=fake_chat), \
                 patch.object(audit, "import_to_local", return_value="test-package") as importer:
                audit.audit_and_publish(args)
                audit.audit_and_publish(args)
                importer.assert_called_once()
            self.assertEqual(sorted(seen_indices), [0, 1, 3, 4])
            review = builder.load_review(args.review)
            self.assertEqual([x["status"] for x in review["entries"]],
                             ["approved", "approved", "rejected", "rejected", "rejected"])
            self.assertEqual(review["autoPublish"]["packageId"], "test-package")
            snapshot = builder.load_snapshot(args.output)
            self.assertEqual([c["labels"]["zh-Hans"] for c in snapshot["concepts"]], ["生日", "蛋糕"])
            self.assertEqual(snapshot["concepts"][0]["definitions"]["zh-Hans"], "与日常文化有关的事物")
            self.assertEqual(review["entries"][0]["generatedHint"], "生活中的一种纪念日")
            self.assertEqual(review["entries"][0]["hintPolicy"], audit.SAFE_HINT_POLICY)
            self.assertEqual(snapshot["sourceManifest"][0]["sourceId"], "ai_generated_model_audited")

    def test_model_failure_keeps_pending_and_never_imports(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.fixture(Path(folder))
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), \
                 patch.object(builder, "chat_completion", side_effect=RuntimeError("模型接口 HTTP 503")), \
                 patch.object(audit, "import_to_local") as importer:
                with self.assertRaisesRegex(RuntimeError, "503"):
                    audit.audit_and_publish(args)
                importer.assert_not_called()
            self.assertFalse(args.output.exists())
            review = builder.load_review(args.review)
            self.assertEqual(review["entries"][0]["status"], "pending")
            self.assertEqual(review["entries"][2]["status"], "rejected")

    def test_incomplete_model_decisions_split_until_each_item_is_audited(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.fixture(Path(folder))
            sizes = []

            def fake_chat(*call_args, **_kwargs):
                rows = json.loads(call_args[3])["entries"]
                sizes.append(len(rows))
                if len(rows) > 1:
                    return {"decisions": []}
                return {"decisions": [{"index": rows[0]["index"], "verdict": "approve", "reason": "合适"}]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), \
                 patch.object(builder, "chat_completion", side_effect=fake_chat), \
                 patch.object(audit, "import_to_local", return_value="test-package"):
                audit.audit_and_publish(args)
            self.assertIn(4, sizes)
            self.assertEqual(sizes.count(1), 4)

    def test_import_rejects_nonlocal_targets_before_reading_package(self):
        with self.assertRaisesRegex(ValueError, "本机"):
            audit.import_to_local(Path("missing.json"), "https://example.org")

    def test_corrected_hint_retry_restores_only_related_rejected_guesses(self):
        review = {"entries": [
            {"word": "筷子", "role": "answer", "category": "food", "hint": "吃饭时夹菜的工具",
             "status": "rejected", "auditModel": audit.AUDIT_MODEL, "auditReason": "提示与答案矛盾"},
            {"word": "餐具", "role": "guess", "sourceAnswer": "筷子", "status": "rejected",
             "auditModel": "local-rules", "auditReason": "所属新题未通过审核"},
            {"word": "饭碗", "role": "guess", "sourceAnswer": "筷子", "status": "rejected",
             "auditModel": audit.AUDIT_MODEL, "auditReason": "关联较弱"},
        ]}
        self.assertEqual(audit.retry_corrected_hint_rejections(review, audit.AUDIT_MODEL), 1)
        self.assertEqual([x["status"] for x in review["entries"]], ["pending", "pending", "rejected"])
        self.assertEqual(review["entries"][0]["category"], "household_items")
        self.assertEqual(audit.prepare_pending_hints(review, {"concepts": []}, builder.UNSAFE_FRAGMENTS), 1)
        self.assertEqual(review["entries"][0]["hint"], "进餐时常用的工具")
        self.assertEqual(audit.retry_corrected_hint_rejections(review, audit.AUDIT_MODEL), 0)


if __name__ == "__main__":
    unittest.main()
