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


def sub(username, seconds, score, hidden=False, subtasks=None, task_id=10):
    return {
        "username": username,
        "first_name": username,
        "last_name": "",
        "task_id": task_id,
        "task_name": "p1",
        "subtask_scores": subtasks,
        "seconds_since_start": seconds,
        "score": score,
        "compilation_outcome": "ok",
        "evaluation_outcome": "ok",
        "hidden": hidden,
    }


def convert(submissions, freeze_minutes=60, score_modes=None):
    return e.build_contest_json(META, submissions, INDICES, MAX_SCORES, freeze_minutes,
                                score_modes=score_modes)


def verdicts(cj, username=None):
    vs = sorted(cj["solutions"].values(), key=lambda s: s["submitted_seconds"])
    return [s["verdict"] for s in vs if username is None or s["user_id"] == username]


SUBTASK_MODE = {10: e.SCORE_MODE_MAX_SUBTASK}


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


class TestScoreMode(unittest.TestCase):
    """CMS score_mode = max_subtask (the IOI 2017 rule): every subtask keeps its
    best result across all submissions and the task score is their sum, so a team
    can hold a score no single submission of theirs ever achieved."""

    def test_max_subtask_sums_best_of_each_subtask_across_submissions(self):
        cj, _ = convert([
            sub("alice", 1000, 20.0, subtasks={"1": 0.0, "2": 20.0, "3": 0.0}),
            sub("alice", 2000, 30.0, subtasks={"1": 0.0, "2": 0.0, "3": 30.0}),
        ], score_modes=SUBTASK_MODE)
        # 30 是單筆最高分, 但 CMS 記的是 20+30
        self.assertEqual(verdicts(cj), ["P20", "P50"])

    def test_max_subtask_matches_cms_for_a_real_three_submission_case(self):
        # Day5_Team18 / Day5-germany-bone: 19, 13, 44 -> CMS 顯示 63
        cj, _ = convert([
            sub("alice", 1000, 19.0, subtasks={"1": 0.0, "2": 0.0, "3": 19.0, "4": 0.0}),
            sub("alice", 2000, 13.0, subtasks={"1": 0.0, "2": 13.0, "3": 0.0, "4": 0.0}),
            sub("alice", 3000, 44.0, subtasks={"1": 0.0, "2": 13.0, "3": 0.0, "4": 31.0}),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj), ["P19", "P32", "P63"])

    def test_max_subtask_reaches_ac_only_when_the_sum_is_full(self):
        cj, _ = convert([
            sub("alice", 1000, 40.0, subtasks={"1": 40.0, "2": 0.0}),
            sub("alice", 2000, 60.0, subtasks={"1": 0.0, "2": 60.0}),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj), ["P40", "AC"])

    def test_score_never_goes_down(self):
        cj, _ = convert([
            sub("alice", 1000, 50.0, subtasks={"1": 50.0}),
            sub("alice", 2000, 0.0, subtasks={"1": 0.0}),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj), ["P50", "P50"])

    def test_subtask_bests_are_tracked_per_team_and_task(self):
        cj, _ = convert([
            sub("alice", 1000, 20.0, subtasks={"1": 20.0, "2": 0.0}),
            sub("bob",   1100, 30.0, subtasks={"1": 0.0, "2": 30.0}),
            sub("alice", 2000, 30.0, subtasks={"1": 0.0, "2": 30.0}),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj, "alice"), ["P20", "P50"])
        self.assertEqual(verdicts(cj, "bob"), ["P30"])

    def test_out_of_window_submissions_do_not_feed_the_subtask_bests(self):
        # 賽後練習的提交不能把分數灌進榜單
        cj, _ = convert([
            sub("alice", 1000, 20.0, subtasks={"1": 20.0, "2": 0.0}),
            sub("alice", 99999, 30.0, subtasks={"1": 0.0, "2": 30.0}),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj), ["P20"])

    def test_unscored_submissions_do_not_feed_the_subtask_bests(self):
        bad = sub("alice", 1500, None, subtasks=None)
        bad["evaluation_outcome"] = None
        cj, _ = convert([
            sub("alice", 1000, 20.0, subtasks={"1": 20.0, "2": 0.0}),
            bad,
            sub("alice", 2000, 30.0, subtasks={"1": 0.0, "2": 30.0}),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj), ["P20", "WT", "P50"])

    def test_max_mode_keeps_the_best_single_submission(self):
        cj, _ = convert([
            sub("alice", 1000, 30.0, subtasks={"1": 30.0, "2": 0.0}),
            sub("alice", 2000, 20.0, subtasks={"1": 0.0, "2": 20.0}),
        ], score_modes={10: e.SCORE_MODE_MAX})
        self.assertEqual(verdicts(cj), ["P30", "P30"])

    def test_missing_subtask_detail_falls_back_to_the_submission_score(self):
        # 舊備份沒有 subtask_scores 欄位 -> 只能退回單筆最高分
        cj, _ = convert([
            sub("alice", 1000, 20.0),
            sub("alice", 2000, 30.0),
        ], score_modes=SUBTASK_MODE)
        self.assertEqual(verdicts(cj), ["P20", "P30"])

    def test_unknown_score_mode_falls_back_to_max(self):
        cj, _ = convert([
            sub("alice", 1000, 30.0, subtasks={"1": 30.0, "2": 0.0}),
            sub("alice", 2000, 20.0, subtasks={"1": 0.0, "2": 20.0}),
        ], score_modes={10: "max_tokened_last"})
        self.assertEqual(verdicts(cj), ["P30", "P30"])


class TestSubtaskScores(unittest.TestCase):
    def test_parses_cms_score_details(self):
        details = [
            {"idx": 1, "max_score": 20, "score_fraction": 1.0, "testcases": []},
            {"idx": 2, "max_score": 30, "score_fraction": 0.0, "testcases": []},
        ]
        self.assertEqual(e.subtask_scores(details), {"1": 20.0, "2": 0.0})

    def test_accepts_a_json_string(self):
        self.assertEqual(
            e.subtask_scores('[{"idx": 1, "max_score": 20, "score_fraction": 0.5}]'),
            {"1": 10.0})

    def test_returns_none_for_non_subtask_details(self):
        # ScoreTypeSum 之類的 score_details 是 testcase 清單, 沒有子題結構
        self.assertIsNone(e.subtask_scores([{"idx": "1-01", "outcome": "Correct"}]))
        self.assertIsNone(e.subtask_scores(None))
        self.assertIsNone(e.subtask_scores("not json"))


class TestBackupRoundTrip(unittest.TestCase):
    """dump 寫出的備份必須能被 convert 完整讀回來。子題得分在備份裡是精簡過的
    {idx: 分數} 字典, 不是 CMS 原始的子題清單 -- 這兩種格式曾經被同一個 parser
    處理, 結果字典一律被判成 None, 整份 max_subtask 靜靜退回 max。"""

    def test_subtask_scores_and_score_mode_survive_a_backup(self):
        import tempfile
        meta = {"id": 3, "name": "c", "description": "",
                "start": META["start"], "stop": META["stop"]}
        tasks = [{"id": 10, "num": 0, "name": "p1", "title": "P1",
                  "active_dataset_id": 1, "score_mode": e.SCORE_MODE_MAX_SUBTASK}]
        rows = [
            {"username": "alice", "first_name": "alice", "last_name": "", "hidden": False,
             "task_id": 10, "task_name": "p1", "submission_id": 1,
             "submission_time": META["start"], "seconds_since_start": 1000,
             "score": 20.0, "compilation_outcome": "ok", "evaluation_outcome": "ok",
             "subtask_scores": {"1": 20.0, "2": 0.0}},
            {"username": "alice", "first_name": "alice", "last_name": "", "hidden": False,
             "task_id": 10, "task_name": "p1", "submission_id": 2,
             "submission_time": META["start"], "seconds_since_start": 2000,
             "score": 30.0, "compilation_outcome": "ok", "evaluation_outcome": "ok",
             "subtask_scores": {"1": 0.0, "2": 30.0}},
        ]
        with tempfile.TemporaryDirectory() as d:
            e.write_backup(d, meta, tasks, {10: 100.0}, {10: "score_type_parameters"}, rows)
            _, _, _, score_modes, subs = e.load_backup(d)

        self.assertEqual(score_modes, {10: e.SCORE_MODE_MAX_SUBTASK})
        self.assertEqual([s["subtask_scores"] for s in subs],
                         [{"1": 20.0, "2": 0.0}, {"1": 0.0, "2": 30.0}])

    def test_old_backup_without_the_column_still_converts(self):
        import tempfile
        meta = {"id": 3, "name": "c", "description": "",
                "start": META["start"], "stop": META["stop"]}
        tasks = [{"id": 10, "num": 0, "name": "p1", "title": "P1", "active_dataset_id": 1}]
        rows = [{"username": "alice", "first_name": "alice", "last_name": "", "hidden": False,
                 "task_id": 10, "task_name": "p1", "submission_id": 1,
                 "submission_time": META["start"], "seconds_since_start": 1000,
                 "score": 20.0, "compilation_outcome": "ok", "evaluation_outcome": "ok"}]
        with tempfile.TemporaryDirectory() as d:
            e.write_backup(d, meta, tasks, {10: 100.0}, {10: "score_type_parameters"}, rows)
            _, _, _, score_modes, subs = e.load_backup(d)
        self.assertEqual(score_modes, {10: e.SCORE_MODE_MAX})
        self.assertIsNone(subs[0]["subtask_scores"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
