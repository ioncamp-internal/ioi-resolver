#!/home/dev/.pyenv/versions/3.10.12/bin/python3.10
"""Tests for export_to_resolver's contest.json conversion.

Run: /home/dev/.pyenv/versions/3.10.12/bin/python3.10 test_export_to_resolver.py
"""
import datetime
import unittest

import export_to_resolver as e


META = {
    "id": 3,
    "name": "test-contest",
    "start": datetime.datetime(2026, 7, 13, 10, 40),
    "stop": datetime.datetime(2026, 7, 13, 13, 40),  # 10800s
}

INDICES = {10: {"problem_index": 1, "name": "p1", "title": "P1"}}
MAX_SCORES = {10: 100.0}


def sub(username, seconds, score, hidden=False):
    return {
        "username": username,
        "first_name": username,
        "last_name": "",
        "task_id": 10,
        "task_name": "p1",
        "seconds_since_start": seconds,
        "score": score,
        "compilation_outcome": "ok",
        "evaluation_outcome": "ok",
        "hidden": hidden,
    }


def convert(submissions, freeze_minutes=60):
    return e.build_contest_json(META, submissions, INDICES, MAX_SCORES, freeze_minutes)


class TestSubmissionWindow(unittest.TestCase):
    def test_keeps_in_window_submissions(self):
        cj, stats = convert([sub("alice", 5000, 100.0)])
        self.assertEqual(len(cj["solutions"]), 1)
        self.assertEqual(stats["skipped_before_start"], 0)
        self.assertEqual(stats["skipped_after_stop"], 0)

    def test_drops_submissions_before_contest_start(self):
        cj, stats = convert([sub("alice", -494362, 100.0)])
        self.assertEqual(cj["solutions"], {})
        self.assertEqual(stats["skipped_before_start"], 1)

    def test_drops_submissions_after_contest_stop(self):
        # 7/15 practice submission, two days after the exam ended.
        cj, stats = convert([sub("alice", 176996, 100.0)])
        self.assertEqual(cj["solutions"], {})
        self.assertEqual(stats["skipped_after_stop"], 1)

    def test_keeps_submission_exactly_at_stop(self):
        cj, _ = convert([sub("alice", 10800, 100.0)])
        self.assertEqual(len(cj["solutions"]), 1)

    def test_out_of_window_user_with_no_valid_submission_is_dropped(self):
        cj, _ = convert([sub("ghost", 176996, 100.0)])
        self.assertNotIn("ghost", cj["users"])

    def test_solution_ids_stay_contiguous_after_skipping(self):
        cj, _ = convert([
            sub("alice", -100, 100.0),
            sub("alice", 5000, 30.0),
            sub("alice", 176996, 100.0),
            sub("alice", 6000, 60.0),
        ])
        self.assertEqual(sorted(cj["solutions"], key=int), ["1", "2"])


class TestHiddenParticipations(unittest.TestCase):
    def test_hidden_user_is_dropped_entirely(self):
        cj, stats = convert([sub("temmie", 5000, 100.0, hidden=True)])
        self.assertNotIn("temmie", cj["users"])
        self.assertEqual(cj["solutions"], {})
        self.assertEqual(stats["excluded_users"], ["temmie"])
        self.assertEqual(stats["skipped_hidden"], 1)

    def test_hidden_user_does_not_consume_a_solution_id(self):
        cj, _ = convert([
            sub("temmie", 4000, 100.0, hidden=True),
            sub("alice", 5000, 100.0),
        ])
        self.assertEqual(sorted(cj["solutions"], key=int), ["1"])
        self.assertEqual(cj["solutions"]["1"]["user_id"], "alice")

    def test_hidden_user_cannot_take_first_to_solve(self):
        # The real bug: an admin test account submitting early would otherwise
        # own the earliest AC for a problem.
        cj, _ = convert([
            sub("temmie", 100, 100.0, hidden=True),
            sub("alice", 5000, 100.0),
        ])
        acs = [s for s in cj["solutions"].values() if s["verdict"] == "AC"]
        self.assertEqual([s["user_id"] for s in acs], ["alice"])

    def test_regular_user_is_not_excluded(self):
        cj, _ = convert([sub("alice", 5000, 100.0)])
        self.assertFalse(cj["users"]["alice"]["is_exclude"])


class TestFrozenSecond(unittest.TestCase):
    def test_frozen_second_is_duration_minus_freeze(self):
        cj, _ = convert([sub("alice", 5000, 100.0)], freeze_minutes=60)
        self.assertEqual(cj["frozen_second"], 7200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
