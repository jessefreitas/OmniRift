#!/usr/bin/env python3
"""Regressões do Stop hook local-review (somente stdlib)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import types
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("local-review.py")
SPEC = importlib.util.spec_from_file_location("omnirift_local_review", SCRIPT)
assert SPEC and SPEC.loader
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def init_repo() -> tempfile.TemporaryDirectory[str]:
    tmp = tempfile.TemporaryDirectory()
    root = Path(tmp.name)
    git(root, "init", "-q")
    git(root, "config", "user.email", "test@omnirift.local")
    git(root, "config", "user.name", "OmniRift Test")
    (root / "tracked.txt").write_text("base\n", encoding="utf-8")
    git(root, "add", "tracked.txt")
    git(root, "commit", "-qm", "base")
    return tmp


class LocalReviewTests(unittest.TestCase):
    def test_stop_hook_llm_timeout_is_short_and_capped(self) -> None:
        self.assertEqual(review._llm_timeout_seconds({}, hook_mode=True), 12.0)
        self.assertEqual(
            review._llm_timeout_seconds({"hookTimeoutSeconds": 999}, hook_mode=True),
            30.0,
        )
        self.assertEqual(
            review._llm_timeout_seconds({"hookTimeoutSeconds": "inválido"}, hook_mode=True),
            12.0,
        )
        self.assertEqual(review._llm_timeout_seconds({}, hook_mode=False), 180.0)

    def test_llm_call_forwards_the_timeout_budget(self) -> None:
        response = mock.Mock()
        response.read.return_value = b'{"choices":[{"message":{"content":"[]"}}]}'
        llm = {
            "baseUrl": "https://llm.invalid",
            "provider": "openai",
            "model": "fixture",
        }
        with mock.patch.object(review.urllib.request, "urlopen", return_value=response) as open_url:
            self.assertEqual(review.llm_call(llm, "system", "prompt", timeout_s=7), "[]")

        self.assertEqual(open_url.call_args.kwargs["timeout"], 7)

    def test_scoped_scanners_preserve_full_gate_contract_and_find(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "changed.py"
            target.write_text("token = 'fixture'\n", encoding="utf-8")
            (root / ".gitleaks.toml").write_text("[allowlist]\n", encoding="utf-8")
            commands: list[list[str]] = []

            def fake_run_tool(cmd: list[str], timeout: int):
                commands.append(cmd)
                if cmd[0] == "gitleaks":
                    report = Path(cmd[cmd.index("--report-path") + 1])
                    report.write_text(
                        json.dumps(
                            [{"File": str(target), "StartLine": 1, "RuleID": "fixture-secret"}]
                        ),
                        encoding="utf-8",
                    )
                    return "ran", types.SimpleNamespace(returncode=1, stdout="", stderr="")
                payload = {
                    "results": [
                        {
                            "path": str(target),
                            "start": {"line": 1},
                            "check_id": "fixture.security",
                            "extra": {"severity": "ERROR", "message": "fixture inseguro"},
                        }
                    ]
                }
                return "ran", types.SimpleNamespace(
                    returncode=1,
                    stdout=json.dumps(payload),
                    stderr="",
                )

            with mock.patch.object(review, "_run_tool", side_effect=fake_run_tool):
                findings, skipped = review.security_gates(str(root), ["changed.py"])

            self.assertEqual(skipped, [])
            self.assertEqual(len(findings), 2)
            gitleaks_cmd = next(cmd for cmd in commands if cmd[0] == "gitleaks")
            for required in ("--no-git", "--redact", "--config", "--exit-code"):
                self.assertIn(required, gitleaks_cmd)
            semgrep_cmd = next(cmd for cmd in commands if cmd[0] == "semgrep")
            self.assertEqual(semgrep_cmd.count("--config"), 2)
            self.assertIn("p/security-audit", semgrep_cmd)
            self.assertIn("p/secrets", semgrep_cmd)
            self.assertIn("--error", semgrep_cmd)

    def test_fingerprint_changes_when_already_modified_file_changes_again(self) -> None:
        tmp = init_repo()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        tracked = root / "tracked.txt"
        tracked.write_text("primeira alteração\n", encoding="utf-8")
        first = review.tree_fingerprint(str(root))
        self.assertTrue(first)
        self.assertIn(" M tracked.txt", git(root, "status", "--short"))

        tracked.write_text("primeira alteração\nsegredo novo\n", encoding="utf-8")
        second = review.tree_fingerprint(str(root))
        self.assertTrue(second)
        self.assertIn(" M tracked.txt", git(root, "status", "--short"))
        self.assertNotEqual(first, second)

    def test_fingerprint_tracks_untracked_content(self) -> None:
        tmp = init_repo()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        extra = root / "novo arquivo.txt"
        extra.write_text("um\n", encoding="utf-8")
        first = review.tree_fingerprint(str(root))
        extra.write_text("dois\n", encoding="utf-8")
        second = review.tree_fingerprint(str(root))
        self.assertNotEqual(first, second)

    def test_changed_files_handles_rename_and_spaces(self) -> None:
        tmp = init_repo()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        git(root, "mv", "tracked.txt", "renomeado com espaço.txt")
        (root / "novo com espaço.txt").write_text("novo\n", encoding="utf-8")
        changed = review._changed_files(str(root), "HEAD")
        self.assertIsNotNone(changed)
        self.assertIn("renomeado com espaço.txt", changed)
        self.assertIn("novo com espaço.txt", changed)

    def test_singleflight_runs_producer_once(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            lock_path = str(Path(raw) / "review.lock")
            started = threading.Event()
            result_ready = threading.Event()
            state = {"calls": 0, "result": None}
            state_lock = threading.Lock()

            def produce():
                with state_lock:
                    state["calls"] += 1
                started.set()
                time.sleep(0.15)
                result = ([{"title": "ok"}], [])
                state["result"] = result
                result_ready.set()
                return result

            def wait_result():
                return state["result"] if result_ready.is_set() else None

            results: list[object] = []
            first = threading.Thread(
                target=lambda: results.append(
                    review._with_singleflight(lock_path, produce, wait_result, timeout_s=2)
                )
            )
            second = threading.Thread(
                target=lambda: results.append(
                    review._with_singleflight(lock_path, produce, wait_result, timeout_s=2)
                )
            )
            first.start()
            self.assertTrue(started.wait(1))
            second.start()
            first.join(3)
            second.join(3)

            self.assertEqual(state["calls"], 1)
            self.assertEqual(len(results), 2)
            self.assertEqual(results[0], results[1])
            self.assertFalse(Path(lock_path).exists())

    def test_security_stage_cache_hits_then_invalidates_on_content(self) -> None:
        tmp = init_repo()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        tracked = root / "tracked.txt"
        tracked.write_text("alteração um\n", encoding="utf-8")
        calls = 0

        def fake_gate(_cwd: str, scope):
            nonlocal calls
            calls += 1
            return ([{"title": f"scan-{calls}", "scope": scope}], [])

        with tempfile.TemporaryDirectory() as cache_raw:
            with (
                mock.patch.object(review, "_cache_dir", return_value=cache_raw),
                mock.patch.object(review, "security_gates", side_effect=fake_gate),
            ):
                first, _ = review._security_stage(str(root), "HEAD", True)
                cached, _ = review._security_stage(str(root), "HEAD", True)
                self.assertEqual(calls, 1)
                self.assertEqual(first, cached)

                # Continua status M, mas o conteúdo muda: não pode servir o cache anterior.
                tracked.write_text("alteração um\nsegredo novo\n", encoding="utf-8")
                refreshed, _ = review._security_stage(str(root), "HEAD", True)

        self.assertEqual(calls, 2)
        self.assertNotEqual(first, refreshed)

    def test_diff_cache_is_never_served_as_full(self) -> None:
        with tempfile.TemporaryDirectory() as cache_raw:
            with mock.patch.object(review, "_cache_dir", return_value=cache_raw):
                review.cache_put("/repo", "fp", "diff", ([{"title": "diff"}], []))
                self.assertIsNotNone(review.cache_get("/repo", "fp", "diff"))
                self.assertIsNone(review.cache_get("/repo", "fp", "full"))

    def test_scope_discovery_failure_falls_back_to_full_scan(self) -> None:
        expected = ([{"title": "full"}], ["scanner-note"])
        with (
            mock.patch.object(review, "tree_fingerprint", return_value=""),
            mock.patch.object(review, "_changed_files", return_value=None),
            mock.patch.object(review, "security_gates", return_value=expected) as gate,
        ):
            result, scope = review._security_stage("/tmp/repo", "HEAD", True)

        gate.assert_called_once_with("/tmp/repo", None)
        self.assertEqual(scope, "diff")
        self.assertEqual(result[0], expected[0])
        self.assertIn("árvore inteira escaneada", result[1][0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
