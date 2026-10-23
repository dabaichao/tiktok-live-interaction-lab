"""Run with: python -m unittest discover -s tests -p test_dictionary_builder.py"""

import argparse
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib import error

from tools import dictionary_builder as builder


class DictionaryBuilderTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "Windows DPAPI required")
    def test_api_key_is_cached_for_current_windows_user_not_written_plaintext(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "key.dpapi"
            missing_local_config = Path(folder) / "missing-local.json"
            with patch.dict(os.environ, {"WORDLIB_API_KEY": ""}), patch.object(builder.getpass, "getpass", return_value="test-secret") as prompt:
                self.assertEqual(builder.get_api_key(True, path, missing_local_config), "test-secret")
                self.assertTrue(path.exists())
                self.assertNotIn(b"test-secret", path.read_bytes())
                self.assertEqual(builder.get_api_key(False, path, missing_local_config), "test-secret")
                prompt.assert_called_once()
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "override"}):
                self.assertEqual(builder.get_api_key(False, path, missing_local_config), "override")

    def test_corrupt_key_cache_fails_closed_without_prompting_again(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "key.dpapi"
            path.write_bytes(b"invalid encrypted bytes")
            with patch.dict(os.environ, {"WORDLIB_API_KEY": ""}), patch.object(builder.getpass, "getpass") as prompt:
                with self.assertRaisesRegex(RuntimeError, "无法读取"):
                    builder.get_api_key(True, path, Path(folder) / "missing-local.json")
                prompt.assert_not_called()

    def test_local_only_config_supplies_exact_model_and_key_without_prompt(self):
        with tempfile.TemporaryDirectory() as folder:
            config_path = Path(folder) / "local.json"
            builder.atomic_json(config_path, {"apiBase": "http://127.0.0.1:3000/v1", "model": "hy", "apiKey": "test-local-secret"})
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "", "WORDLIB_MODEL": "", "WORDLIB_API_BASE_URL": ""}), \
                 patch.object(builder, "DEFAULT_LOCAL_CONFIG", config_path), \
                 patch.object(builder.getpass, "getpass") as prompt:
                self.assertEqual(builder.parser().parse_args(["batch"]).model, "hy")
                self.assertEqual(builder.get_api_key(True, Path(folder) / "missing.dpapi", config_path), "test-local-secret")
                prompt.assert_not_called()

    def test_rejects_answer_leaks_duplicates_and_sensitive_words(self):
        known = {"苹果"}
        valid = {"word": "橘子", "role": "answer", "category": "food", "partOfSpeech": "名词", "hint": "一种常见的水果"}
        self.assertIsNone(builder.validate_item(valid, known, 2)[1])
        self.assertEqual(builder.validate_item({**valid, "word": "苹果"}, known, 2)[1], "重复词")
        self.assertEqual(builder.validate_item({**valid, "hint": "橘子是一种水果"}, known, 2)[1], "提示直接包含答案或别名")
        self.assertEqual(builder.validate_item({**valid, "word": "毒品"}, known, 2)[1], "敏感词片段")
        self.assertEqual(builder.validate_item({**valid, "word": "热闹"}, known, 3)[1], "字数不符")
        self.assertEqual(builder.validate_item({**valid, "word": "橘子!"}, known, 2)[1], "词形不合规")
        self.assertEqual(builder.validate_hint("橘子", "甜橙一类的水果", aliases=("甜橙",)), "提示直接包含答案或别名")

    def test_model_json_accepts_fenced_output_and_rejects_non_json(self):
        self.assertEqual(builder.model_json('```json\n{"items":[]}\n```'), {"items": []})
        self.assertEqual(builder.model_json('{"questions":[]}', "questions"), {"questions": []})
        with self.assertRaises(ValueError):
            builder.model_json("没有 JSON")

    def test_remote_http_requires_explicit_opt_in_before_network(self):
        with patch.object(builder.request, "urlopen") as urlopen:
            with self.assertRaisesRegex(ValueError, "明文"):
                builder.chat_completion("http://203.0.113.20:3000/v1", "test-secret", "hy3", "test", 1)
            urlopen.assert_not_called()

    def test_direct_launch_opens_wizard_and_can_cancel_before_network(self):
        class TerminalInput(io.StringIO):
            def isatty(self):
                return True

        with patch.object(sys, "argv", ["dictionary_builder.py"]), patch.object(sys, "stdin", TerminalInput()), \
             patch.dict(os.environ, {"WORDLIB_API_BASE_URL": "http://203.0.113.20:3000/v1"}), \
             patch("builtins.input", side_effect=["森林", "3", ""]), \
             patch.object(builder, "chat_completion") as chat:
            self.assertEqual(builder.main(), 0)
        chat.assert_not_called()

    def test_direct_launch_accepts_lowercase_yes_and_uses_batch_mode(self):
        class TerminalInput(io.StringIO):
            def isatty(self):
                return True

        with patch.object(sys, "argv", ["dictionary_builder.py"]), patch.object(sys, "stdin", TerminalInput()), \
             patch.dict(os.environ, {"WORDLIB_API_BASE_URL": "http://203.0.113.20:3000/v1"}), \
             patch("builtins.input", side_effect=["生日,森林", "5", "yes"]), \
             patch.object(builder, "generate_batch") as batch:
            self.assertEqual(builder.main(), 0)
            args = batch.call_args.args[0]
            self.assertEqual(args.answers, "生日,森林")
            self.assertEqual(args.related_per_question, 5)
            self.assertTrue(args.allow_insecure_http)

    def test_direct_launch_accepts_twenty_related_words_without_network_validation_error(self):
        class TerminalInput(io.StringIO):
            def isatty(self):
                return True

        with patch.object(sys, "argv", ["dictionary_builder.py"]), patch.object(sys, "stdin", TerminalInput()), \
             patch.dict(os.environ, {"WORDLIB_API_BASE_URL": "http://203.0.113.20:3000/v1"}), \
             patch("builtins.input", side_effect=["生日,彩虹", "20", "yes"]), \
             patch.object(builder, "generate_batch") as batch:
            self.assertEqual(builder.main(), 0)
            self.assertEqual(batch.call_args.args[0].related_per_question, 20)

    def test_openai_compatible_request_and_strict_json_response(self):
        response = {"choices": [{"message": {"content": '{"items":[{"word":"橘子","role":"guess","category":"food","partOfSpeech":"名词","hint":""}]}'}}]}

        class FakeOpener:
            def open(self, req, timeout):
                self.url = req.full_url
                self.body = json.loads(req.data)
                self.authorization = req.get_header("Authorization")
                return io.BytesIO(json.dumps(response, ensure_ascii=False).encode("utf-8"))

        opener = FakeOpener()
        with patch.object(builder.request, "build_opener", return_value=opener):
            result = builder.chat_completion("https://model.example/v1", "test-secret", "hy3", "two words", 2)
        self.assertEqual(opener.url, "https://model.example/v1/chat/completions")
        self.assertEqual(opener.body["model"], "hy3")
        self.assertEqual(opener.body["messages"][1]["content"], "two words")
        self.assertEqual(opener.authorization, "Bearer test-secret")
        self.assertEqual(result["items"][0]["word"], "橘子")

    def test_explicit_disabled_thinking_is_sent_and_logged_without_secrets(self):
        response = {"choices": [{"finish_reason": "stop", "message": {"content": '{"questions":[]}'}}],
                    "usage": {"completion_tokens": 12, "completion_tokens_details": {"reasoning_tokens": 0}}}

        class FakeOpener:
            def open(self, req, timeout):
                self.body = json.loads(req.data)
                return io.BytesIO(json.dumps(response).encode("utf-8"))

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "diagnostics.jsonl"
            opener = FakeOpener()
            with patch.object(builder.request, "build_opener", return_value=opener):
                self.assertEqual(builder.chat_completion("https://model.example/v1", "test-secret",
                    "deepseek-v4.1-flash", "private-prompt", 2, result_key="questions", json_mode=True,
                    disable_thinking=True, diagnostic_path=path)["questions"], [])
            self.assertEqual(opener.body["thinking"], {"type": "disabled"})
            self.assertNotIn("reasoning_effort", opener.body)
            record = json.loads(path.read_text(encoding="utf-8").strip())
            self.assertTrue(record["thinking_disabled"])
            self.assertEqual(record["reasoning_tokens"], 0)
            self.assertNotIn("test-secret", path.read_text(encoding="utf-8"))
            self.assertNotIn("private-prompt", path.read_text(encoding="utf-8"))

    def test_truncated_response_writes_metadata_but_never_prompt_or_secret(self):
        response = {"choices": [{"finish_reason": "length", "message": {"content": '{"questions":['}}],
                    "usage": {"completion_tokens": 120, "completion_tokens_details": {"reasoning_tokens": 110}}}

        class FakeOpener:
            def open(self, req, timeout):
                self.body = json.loads(req.data)
                return io.BytesIO(json.dumps(response).encode("utf-8"))

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "diagnostics.jsonl"
            opener = FakeOpener()
            with patch.object(builder.request, "build_opener", return_value=opener):
                with self.assertRaisesRegex(builder.ModelOutputError, "token 上限"):
                    builder.chat_completion("https://model.example/v1", "test-secret", "hy3", "private-prompt", 2,
                                            result_key="questions", reasoning_effort="low", json_mode=True,
                                            diagnostic_path=path, diagnostic_meta={"batch": 1, "questions": 4})
            self.assertEqual(opener.body["reasoning_effort"], "low")
            self.assertEqual(opener.body["response_format"], {"type": "json_object"})
            record = json.loads(path.read_text(encoding="utf-8").strip())
            self.assertEqual(record["status"], "truncated")
            self.assertEqual(record["finish_reason"], "length")
            self.assertEqual(record["reasoning_tokens"], 110)
            self.assertNotIn("test-secret", path.read_text(encoding="utf-8"))
            self.assertNotIn("private-prompt", path.read_text(encoding="utf-8"))
            self.assertNotIn('{"questions":[', path.read_text(encoding="utf-8"))

    def test_json_mode_rejection_falls_back_without_logging_response_body(self):
        response = {"choices": [{"finish_reason": "stop", "message": {"content": '{"questions":[]}'}}]}

        class FakeOpener:
            def __init__(self):
                self.payloads = []

            def open(self, req, timeout):
                self.payloads.append(json.loads(req.data))
                if len(self.payloads) == 1:
                    raise error.HTTPError(req.full_url, 400, "unsupported", None, None)
                return io.BytesIO(json.dumps(response).encode("utf-8"))

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "diagnostics.jsonl"
            opener = FakeOpener()
            with patch.object(builder.request, "build_opener", return_value=opener):
                result = builder.chat_completion("https://model.example/v1", "test-secret", "hy3", "test", 2,
                                                 result_key="questions", json_mode=True, diagnostic_path=path)
            self.assertEqual(result["questions"], [])
            self.assertIn("response_format", opener.payloads[0])
            self.assertNotIn("response_format", opener.payloads[1])
            statuses = [json.loads(line)["status"] for line in path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(statuses, ["json_mode_unsupported", "ok"])

    def test_recent_topics_only_and_no_instructions_promoted(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "topics.json"
            fresh = builder.datetime.now(builder.timezone.utc).isoformat()
            path.write_text(json.dumps([
                {"title": "运动器材受到关注", "source": "用户整理", "publishedAt": fresh},
                {"title": "过期话题", "source": "用户整理", "publishedAt": "2020-01-01T00:00:00Z"},
            ], ensure_ascii=False), encoding="utf-8")
            self.assertEqual(len(builder.load_topics(path)), 1)

    def test_builtin_defaults_to_chinese_and_auto_question_is_two_characters(self):
        snapshot = builder.load_snapshot(builder.DEFAULT_BASE)
        self.assertEqual(snapshot["defaultLanguage"], "zh-Hans")
        self.assertEqual(len(builder.choose_answer(snapshot, builder.UNSAFE_FRAGMENTS)), 2)

    def test_custom_blocklist_applies_to_words_and_hints(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "blocked.txt"
            path.write_text("# 单行注释\n葡萄\n", encoding="utf-8")
            item = {"word": "葡萄", "role": "answer", "category": "food", "partOfSpeech": "名词", "hint": "一种常见的水果"}
            self.assertEqual(builder.validate_item(item, set(), blocklist=builder.load_blocklist(path))[1], "敏感词片段")

    def test_answer_file_accepts_many_questions_and_rejects_bad_words(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "answers.txt"
            path.write_text("生日\n森林，海洋\n", encoding="utf-8")
            self.assertEqual(builder.answer_seeds(None, path, builder.UNSAFE_FRAGMENTS), ["生日", "森林", "海洋"])
            with self.assertRaisesRegex(ValueError, "不是安全"):
                builder.answer_seeds("生日,毒品", None, builder.UNSAFE_FRAGMENTS)

    def test_batch_sends_multiple_questions_per_call_and_checkpoints_review(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            mapping = {"生日": "蛋糕", "森林": "树木", "海洋": "小船", "城市": "街道", "火车": "铁轨", "电脑": "屏幕"}
            args = argparse.Namespace(base=base_path, review=review_path, answers=",".join(mapping), answers_file=None,
                question_count=10, related_per_question=1, word_length=2, batch_size=3, max_calls=3,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False)
            prompts = []

            def fake_chat(*call_args, **_kwargs):
                prompt = json.loads(call_args[3])
                prompts.append(prompt)
                return {"questions": [{"answer": word, "category": "nature", "partOfSpeech": "名词",
                    "hint": "生活中常见的一种事物", "relatedWords": [{"word": mapping[word], "category": "nature", "partOfSpeech": "名词", "relationLevel": "near"}]}
                    for word in prompt["seedAnswers"]]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", side_effect=fake_chat) as chat:
                builder.generate_batch(args)
            self.assertEqual(chat.call_count, 2)
            self.assertEqual([len(prompt["seedAnswers"]) for prompt in prompts], [3, 3])
            entries = builder.load_review(review_path)["entries"]
            self.assertEqual(len([entry for entry in entries if entry.get("role") == "answer"]), 6)
            self.assertEqual(len([entry for entry in entries if entry.get("role") == "guess"]), 6)
            self.assertTrue(all(entry["status"] == "pending" for entry in entries))
            review = builder.load_review(review_path)
            for entry in review["entries"]:
                entry["status"] = "approved"
            builder.atomic_json(review_path, review)
            published_path = directory / "published.json"
            builder.publish(argparse.Namespace(base=base_path, review=review_path, output=published_path,
                                               wordlist_id=None, overwrite=False, blocklist=None))
            published = builder.load_snapshot(published_path)
            linked = [concept for concept in published["concepts"] if concept.get("relatedTo")]
            self.assertEqual(len(linked), 6)
            self.assertIn(["生日"], [concept["relatedTo"] for concept in linked])

    def test_twenty_related_words_uses_smaller_request_groups(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            mapping = {"生日": "蛋糕", "森林": "树木", "海洋": "小船", "城市": "街道", "火车": "铁轨", "电脑": "屏幕"}
            args = argparse.Namespace(base=base_path, review=review_path, answers=",".join(mapping), answers_file=None,
                question_count=10, related_per_question=20, word_length=2, batch_size=4, max_calls=3,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False)
            prompts = []

            def fake_chat(*call_args, **_kwargs):
                prompt = json.loads(call_args[3])
                prompts.append(prompt)
                return {"questions": [{"answer": word, "category": "nature", "partOfSpeech": "名词",
                    "hint": "生活中常见的一种事物", "relatedWords": [{"word": mapping[word], "category": "nature", "partOfSpeech": "名词", "relationLevel": "near"}]}
                    for word in prompt["seedAnswers"]]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", side_effect=fake_chat) as chat:
                builder.generate_batch(args)
            self.assertEqual(chat.call_count, 3)
            self.assertEqual([len(prompt["seedAnswers"]) for prompt in prompts], [2, 2, 2])
            self.assertTrue(all(prompt["relatedPerQuestion"] == 20 for prompt in prompts))
            self.assertEqual(len(builder.load_review(review_path)["entries"]), 12)

    def test_invalid_json_shrinks_batch_then_recovers_without_losing_questions(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            mapping = {"生日": "蛋糕", "森林": "树木", "海洋": "小船"}
            args = argparse.Namespace(base=base_path, review=review_path, answers=",".join(mapping), answers_file=None,
                question_count=3, related_per_question=1, word_length=2, batch_size=3, max_calls=4,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False, reasoning_effort="low",
                json_mode=True, diagnostics=directory / "diagnostics.jsonl")
            group_sizes = []

            def fake_chat(*call_args, **kwargs):
                prompt = json.loads(call_args[3])
                group_sizes.append(len(prompt["seedAnswers"]))
                self.assertEqual(kwargs["reasoning_effort"], "low")
                self.assertTrue(kwargs["json_mode"])
                if len(group_sizes) == 1:
                    raise builder.ModelOutputError("synthetic malformed JSON")
                return {"questions": [{"answer": word, "category": "nature", "partOfSpeech": "名词",
                    "hint": "生活中常见的一种事物", "relatedWords": [{"word": mapping[word], "category": "nature", "partOfSpeech": "名词", "relationLevel": "near"}]}
                    for word in prompt["seedAnswers"]]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", side_effect=fake_chat):
                builder.generate_batch(args)
            self.assertEqual(group_sizes, [3, 1, 1, 1])
            entries = builder.load_review(review_path)["entries"]
            self.assertEqual(len([entry for entry in entries if entry.get("role") == "answer"]), 3)
            self.assertEqual(len([entry for entry in entries if entry.get("role") == "guess"]), 3)
            self.assertEqual(builder.load_review(review_path)["rejections"]["模型 JSON 响应不合规"], 1)

    def test_repeated_single_question_json_failure_stops_without_publishing(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            args = argparse.Namespace(base=base_path, review=review_path, answers="生日", answers_file=None,
                question_count=1, related_per_question=5, word_length=2, batch_size=1, max_calls=3,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False)
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), \
                 patch.object(builder, "chat_completion", side_effect=builder.ModelOutputError("malformed")) as chat:
                with self.assertRaisesRegex(RuntimeError, "多次未返回有效 JSON"):
                    builder.generate_batch(args)
            self.assertEqual(chat.call_count, 3)
            self.assertEqual(builder.load_review(review_path)["entries"], [])
            self.assertEqual(builder.load_review(review_path)["rejections"]["模型 JSON 响应不合规"], 3)

    def test_unusable_seed_rotates_so_later_questions_are_not_starved(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026",
                                            "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            args = argparse.Namespace(base=base_path, review=review_path, answers="生日,森林", answers_file=None,
                question_count=2, related_per_question=1, word_length=2, batch_size=1, max_calls=3,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False)
            prompts = []

            def fake_chat(*call_args, **_kwargs):
                word = json.loads(call_args[3])["seedAnswers"][0]
                prompts.append(word)
                if word == "生日":
                    return {"questions": []}
                return {"questions": [{"answer": "森林", "category": "nature", "partOfSpeech": "名词",
                    "hint": "生活中常见的一种事物", "relatedWords": [{"word": "树木", "category": "nature",
                    "partOfSpeech": "名词", "relationLevel": "near"}]}]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), \
                 patch.object(builder, "chat_completion", side_effect=fake_chat):
                builder.generate_batch(args)
            self.assertEqual(prompts, ["生日", "森林", "生日"])
            self.assertEqual([e["word"] for e in builder.load_review(review_path)["entries"]], ["森林", "树木"])

    def test_existing_reviewed_answer_can_gain_related_words_without_replacing_hint(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026",
                                            "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            builder.atomic_json(review_path, {"schemaVersion": 1, "language": "zh-Hans", "rejections": {}, "entries": [
                {"word": "孔雀", "role": "answer", "category": "nature", "partOfSpeech": "名词",
                 "hint": "一种野生鸟类", "status": "approved"}]})
            args = argparse.Namespace(base=base_path, review=review_path, answers="孔雀", answers_file=None,
                question_count=1, related_per_question=1, word_length=2, batch_size=1, max_calls=1,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False)
            response = {"questions": [{"answer": "孔雀", "category": "nature", "partOfSpeech": "名词",
                "hint": "孔雀开屏", "relatedWords": [{"word": "羽毛", "category": "nature",
                "partOfSpeech": "名词", "relationLevel": "near"}]}]}
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), \
                 patch.object(builder, "chat_completion", return_value=response):
                builder.generate_batch(args)
            entries = builder.load_review(review_path)["entries"]
            self.assertEqual([e["word"] for e in entries], ["孔雀", "羽毛"])
            self.assertEqual(entries[0]["hint"], "一种野生鸟类")
            self.assertEqual(entries[1]["sourceAnswer"], "孔雀")

    def test_batch_can_propose_new_questions_and_skips_incomplete_questions(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            args = argparse.Namespace(base=base_path, review=review_path, answers=None, answers_file=None,
                question_count=3, related_per_question=1, word_length=2, batch_size=2, max_calls=2,
                topics_file=None, blocklist=None, api_base="https://example.test/v1", model="hy3",
                timeout=2, allow_insecure_http=False, interactive=False)
            words = [("森林", "树木"), ("海洋", "小船"), ("城市", "街道")]
            batches = [words[:2], words[2:]]

            def fake_chat(*call_args, **_kwargs):
                group = batches.pop(0)
                return {"questions": [{"answer": answer, "category": "nature", "partOfSpeech": "名词",
                    "hint": "生活中常见的一种事物", "relatedWords": [{"word": related, "category": "nature", "partOfSpeech": "名词"}]}
                    for answer, related in group]}

            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", side_effect=fake_chat) as chat:
                builder.generate_batch(args)
            self.assertEqual(chat.call_count, 2)
            self.assertEqual(len(builder.load_review(review_path)["entries"]), 6)
            args.review = directory / "empty-review.json"
            args.answers = "森林"
            args.question_count = 1
            args.max_calls = 1
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", return_value={"questions": [
                {"answer": "森林", "category": "nature", "partOfSpeech": "名词", "hint": "生活中常见的一种事物", "relatedWords": []}
            ]}):
                builder.generate_batch(args)
            self.assertEqual(builder.load_review(args.review)["entries"], [])

    def test_publish_only_reviewed_and_remains_incremental(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path, output_path = (directory / name for name in ("base.json", "review.json", "merged.json"))
            base = {
                "schemaVersion": 1, "wordlistId": "seed", "release": "2026-01-01", "defaultLanguage": "en",
                "languages": ["en", "zh-Hans"], "concepts": [
                    {"conceptId": "fruit.apple", "category": "food", "labels": {"en": "apple", "zh-Hans": "苹果"}}
                ],
            }
            builder.atomic_json(base_path, base)
            review = {"schemaVersion": 1, "language": "zh-Hans", "entries": [
                {"word": "橘子", "role": "answer", "category": "food", "partOfSpeech": "名词", "hint": "一种常见的水果", "status": "approved"},
                {"word": "梨子", "role": "guess", "category": "food", "partOfSpeech": "名词", "hint": "", "status": "approved"},
                {"word": "桃子", "role": "answer", "category": "food", "partOfSpeech": "名词", "hint": "一种常见的水果", "status": "pending"},
                {"word": "苹果", "role": "answer", "category": "food", "partOfSpeech": "名词", "hint": "一种常见的水果", "status": "approved"},
            ], "rejections": {}}
            builder.atomic_json(review_path, review)
            args = argparse.Namespace(base=base_path, review=review_path, output=output_path, wordlist_id=None, overwrite=False, blocklist=None)
            builder.publish(args)
            merged = builder.load_snapshot(output_path)
            self.assertEqual(len(merged["concepts"]), 3)
            self.assertEqual(merged["defaultLanguage"], "zh-Hans")
            self.assertEqual(merged["concepts"][1]["definitions"]["zh-Hans"], "一种常见的水果")
            self.assertTrue(merged["concepts"][1]["isAnswerable"])
            self.assertFalse(merged["concepts"][2]["isAnswerable"])
            with self.assertRaisesRegex(ValueError, "已存在"):
                builder.publish(args)
            args.base, args.output = output_path, directory / "next.json"
            with self.assertRaisesRegex(ValueError, "没有通过复核的新词"):
                builder.publish(args)
            self.assertFalse(args.output.exists())

    def test_generate_checkpoints_and_never_publishes_directly(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            args = argparse.Namespace(base=base_path, review=review_path, topics_file=None, count=1, batch_size=1,
                                      word_length=2, max_calls=1, api_base="https://example.test/v1", model="hy3",
                                      timeout=1, allow_insecure_http=False, blocklist=None)
            output = {"items": [{"word": "橘子", "role": "answer", "category": "food", "partOfSpeech": "名词", "hint": "一种常见的水果"}]}
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", return_value=output) as chat:
                builder.generate(args)
                self.assertEqual(chat.call_count, 1)
            self.assertEqual(builder.load_review(review_path)["entries"][0]["status"], "pending")
            self.assertEqual(len(builder.load_snapshot(base_path)["concepts"]), 0)

    def test_for_answer_generates_hint_and_related_words_but_only_to_review(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": []})
            args = argparse.Namespace(base=base_path, review=review_path, answer="森林", count=2, batch_size=2,
                                      max_calls=2, topics_file=None, blocklist=None, api_base="https://example.test/v1",
                                      model="hy3", timeout=2, allow_insecure_http=False, interactive=False)
            output = {"items": [
                {"word": "森林", "role": "answer", "category": "nature", "partOfSpeech": "名词", "hint": "许多树木生长的地方"},
                {"word": "树木", "role": "guess", "category": "nature", "partOfSpeech": "名词", "hint": "", "relationLevel": "near"},
                {"word": "草原", "role": "guess", "category": "nature", "partOfSpeech": "名词", "hint": "", "relationLevel": "medium"},
            ]}
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", return_value=output) as chat:
                builder.generate_for_answer(args)
            prompt = json.loads(chat.call_args.args[3])
            self.assertEqual(prompt["answer"], "森林")
            self.assertIsNone(prompt["answerPartOfSpeech"])
            self.assertEqual(prompt["wordLength"], 2)
            entries = builder.load_review(review_path)["entries"]
            self.assertEqual([entry["word"] for entry in entries], ["森林", "树木", "草原"])
            self.assertEqual([entry["status"] for entry in entries], ["pending"] * 3)
            self.assertEqual(entries[1]["sourceAnswer"], "森林")
            self.assertEqual(entries[1]["relationLevel"], "near")
            self.assertEqual(builder.load_snapshot(base_path)["concepts"], [])
            review = builder.load_review(review_path)
            for entry in review["entries"]:
                entry["status"] = "approved"
            builder.atomic_json(review_path, review)
            output_path = directory / "published.json"
            builder.publish(argparse.Namespace(base=base_path, review=review_path, output=output_path,
                                               wordlist_id=None, overwrite=False, blocklist=None))
            published = builder.load_snapshot(output_path)
            self.assertEqual(len(published["concepts"]), 3)
            self.assertEqual([item["isAnswerable"] for item in published["concepts"]], [True, False, False])

    def test_for_existing_answer_proposes_hint_update_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path = directory / "base.json", directory / "review.json"
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": [
                {"conceptId": "nature.forest", "category": "nature", "labels": {"zh-Hans": "森林"}, "definitions": {"zh-Hans": "自然界的一种环境"}},
                {"conceptId": "nature.trees", "category": "nature", "labels": {"zh-Hans": "树木"}},
            ]})
            args = argparse.Namespace(base=base_path, review=review_path, answer="森林", count=1, batch_size=1,
                                      max_calls=1, topics_file=None, blocklist=None, api_base="https://example.test/v1",
                                      model="hy3", timeout=2, allow_insecure_http=False, interactive=False)
            output = {"items": [
                {"word": "森林", "role": "answer", "category": "nature", "partOfSpeech": "名词", "hint": "许多树木生长的地方"},
                {"word": "树木", "role": "guess", "category": "nature", "partOfSpeech": "名词", "hint": ""},
                {"word": "草原", "role": "guess", "category": "nature", "partOfSpeech": "名词", "hint": ""},
            ]}
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", return_value=output):
                builder.generate_for_answer(args)
            entries = builder.load_review(review_path)["entries"]
            self.assertEqual([entry["word"] for entry in entries], ["森林", "草原"])
            self.assertEqual(entries[0]["action"], "update_hint")
            self.assertEqual(entries[0]["originalHint"], "自然界的一种环境")

    def test_existing_question_hint_is_reviewed_then_updated_without_new_answer(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            base_path, review_path, output_path = (directory / name for name in ("base.json", "review.json", "merged.json"))
            builder.atomic_json(base_path, {"schemaVersion": 1, "wordlistId": "seed", "release": "2026", "defaultLanguage": "zh-Hans", "languages": ["zh-Hans"], "concepts": [
                {"conceptId": "nature.forest", "category": "nature", "labels": {"zh-Hans": "森林"}}
            ]})
            args = argparse.Namespace(base=base_path, review=review_path, count=1, batch_size=1, word_length=2,
                                      blocklist=None, api_base="https://example.test/v1", model="hy3", timeout=2,
                                      allow_insecure_http=False)
            with patch.dict(os.environ, {"WORDLIB_API_KEY": "test-secret"}), patch.object(builder, "chat_completion", return_value={"items": [{"word": "森林", "hint": "许多树木聚集的地方"}]}):
                builder.generate_hints(args)
            entry = builder.load_review(review_path)["entries"][0]
            self.assertEqual(entry["status"], "pending")
            self.assertEqual(entry["action"], "update_hint")
            entry["status"] = "approved"
            review = builder.load_review(review_path)
            review["entries"][0] = entry
            builder.atomic_json(review_path, review)
            builder.publish(argparse.Namespace(base=base_path, review=review_path, output=output_path,
                                               wordlist_id=None, overwrite=False, blocklist=None))
            merged = builder.load_snapshot(output_path)
            self.assertEqual(len(merged["concepts"]), 1)
            self.assertEqual(merged["concepts"][0]["definitions"]["zh-Hans"], "许多树木聚集的地方")
            with self.assertRaisesRegex(ValueError, "没有通过复核的新词"):
                builder.publish(argparse.Namespace(base=output_path, review=review_path, output=directory / "next.json",
                                                   wordlist_id=None, overwrite=False, blocklist=None))


if __name__ == "__main__":
    unittest.main()
