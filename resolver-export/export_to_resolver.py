#!/home/dev/.pyenv/versions/3.10.12/bin/python3.10
"""Export CMS contest submissions into the ioi-resolver contest.json format.

Subcommands: dump, convert, serve, all (default).

Security note: all values pulled from the CMS database (usernames, task
names, etc.) are treated as inert data. They are only ever written out via
json.dump/csv.writer, and the only subprocess invocation in this script uses
a fixed argument list that never includes database-derived strings. All SQL
uses parameterized queries.
"""
import argparse
import csv
import datetime
import json
import logging
import os
import re
import signal
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

PYENV_PY = sys.executable
DEFAULT_EXPORTS_DIR = os.path.join(SCRIPT_DIR, "exports")
DEFAULT_RESOLVER_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_PORT = 8899
DEFAULT_FREEZE_MINUTES = 60

logger = logging.getLogger("export_to_resolver")


def get_db_connection():
    """Return a psycopg2 connection, reusing CMS's own configured engine."""
    from cms.db import engine as cms_engine
    return cms_engine.raw_connection()


def slugify(name):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("_") or "contest"


# ---------------------------------------------------------------------------
# Fetch functions (all read-only, parameterized SQL)
# ---------------------------------------------------------------------------

def fetch_contest_meta(conn, contest_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, description, start, stop "
            "FROM contests WHERE id = %s",
            (contest_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise SystemExit(f"No contest with id={contest_id} found in cmsdb.")
    return {
        "id": row[0],
        "name": row[1],
        "description": row[2],
        "start": row[3],
        "stop": row[4],
    }


def fetch_tasks(conn, contest_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, num, name, title, active_dataset_id "
            "FROM tasks WHERE contest_id = %s ORDER BY num, name",
            (contest_id,),
        )
        rows = cur.fetchall()
    return [
        {"id": r[0], "num": r[1], "name": r[2], "title": r[3], "active_dataset_id": r[4]}
        for r in rows
    ]


def fetch_task_max_scores(conn, tasks):
    """Authoritative max score per task, from datasets.score_type_parameters.

    Falls back to MAX(score) seen in submission_results if the parameters
    aren't in the expected per-subtask tuple-list shape. The fallback is
    flagged in the returned dict so callers can note it in the manifest.
    """
    max_scores = {}
    sources = {}

    dataset_ids = [t["active_dataset_id"] for t in tasks if t["active_dataset_id"] is not None]
    dataset_by_id = {}
    if dataset_ids:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, task_id, score_type, score_type_parameters "
                "FROM datasets WHERE id = ANY(%s)",
                (dataset_ids,),
            )
            for ds_id, task_id, score_type, params in cur.fetchall():
                dataset_by_id[ds_id] = (task_id, score_type, params)

    for task in tasks:
        task_id = task["id"]
        ds = dataset_by_id.get(task["active_dataset_id"])
        computed = None
        if ds is not None:
            _, _, params = ds
            try:
                computed = sum(float(subtask[0]) for subtask in params)
            except (TypeError, ValueError, IndexError):
                computed = None

        if computed is not None:
            max_scores[task_id] = computed
            sources[task_id] = "score_type_parameters"
        else:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT MAX(score) FROM submission_results sr "
                    "JOIN submissions s ON s.id = sr.submission_id "
                    "WHERE s.task_id = %s",
                    (task_id,),
                )
                (fallback_max,) = cur.fetchone()
            max_scores[task_id] = float(fallback_max) if fallback_max is not None else 0.0
            sources[task_id] = "fallback:MAX(score)"
            logger.warning(
                "Task '%s' (id=%d): could not derive max_score from "
                "score_type_parameters; using inferred fallback MAX(score)=%s "
                "(NOT authoritative).",
                task["name"], task_id, max_scores[task_id],
            )

    return max_scores, sources


def fetch_submissions(conn, contest_id):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT u.username, u.first_name, u.last_name, p.hidden,
                   t.id AS task_id, t.name AS task_name,
                   s.id AS submission_id, s.timestamp AS submission_time,
                   EXTRACT(EPOCH FROM (s.timestamp - c.start))::bigint AS seconds_since_start,
                   sr.score, sr.compilation_outcome, sr.evaluation_outcome
            FROM submissions s
            JOIN tasks t ON t.id = s.task_id
            JOIN participations p ON p.id = s.participation_id
            JOIN users u ON u.id = p.user_id
            JOIN contests c ON c.id = p.contest_id
            LEFT JOIN submission_results sr
                   ON sr.submission_id = s.id AND sr.dataset_id = t.active_dataset_id
            WHERE p.contest_id = %s AND t.contest_id = %s
            ORDER BY s.timestamp
            """,
            (contest_id, contest_id),
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    return rows


# ---------------------------------------------------------------------------
# Conversion logic
# ---------------------------------------------------------------------------

def derive_verdict(score, max_score, compilation_outcome, evaluation_outcome):
    if compilation_outcome == "fail":
        return "CE"
    if score is None or evaluation_outcome != "ok":
        return "WT"
    if max_score is None or max_score <= 0:
        logger.warning("max_score <= 0 encountered; marking submission as WT.")
        return "WT"
    if score >= max_score - 1e-6:
        return "AC"
    return "P" + str(int(round(score)))


def assign_problem_indices(tasks, max_scores):
    ordered = sorted(tasks, key=lambda t: (t["num"], t["name"]))
    indices = {}
    excluded = []
    next_index = 1
    for t in ordered:
        if t["active_dataset_id"] is None:
            excluded.append({"task_id": t["id"], "name": t["name"], "reason": "no active_dataset_id"})
            logger.warning("Task '%s' (id=%d) has no active dataset; excluding from export.", t["name"], t["id"])
            continue
        indices[t["id"]] = {"problem_index": next_index, "name": t["name"], "title": t["title"]}
        next_index += 1
    return indices, excluded


def build_contest_json(meta, submissions, indices, max_scores, freeze_minutes):
    """Convert dumped submissions into the resolver's contest.json shape.

    Only submissions inside the contest window [start, stop] count. CMS keeps
    accepting submissions after the contest ends (students practising) and the
    admin's own test submissions predate the start; both would otherwise land
    past frozen_second and get "revealed" as if they had been earned during the
    contest. Hidden participations are dropped entirely: they used to be kept
    and marked is_exclude, which left them occupying a row in the reveal and
    let admin test accounts steal first-to-solve from real teams.

    Returns (contest_json, stats).
    """
    duration_seconds = int((meta["stop"] - meta["start"]).total_seconds())
    frozen_second = max(0, duration_seconds - freeze_minutes * 60)

    solutions = {}
    users = {}
    max_seen_seconds = 0
    skipped_before_start = 0
    skipped_after_stop = 0
    skipped_excluded_task = 0
    skipped_hidden = 0
    hidden_users = set()

    seq = 0
    for row in submissions:
        task_id = row["task_id"]
        if task_id not in indices:
            skipped_excluded_task += 1
            continue  # excluded task (no active dataset)

        if row.get("hidden"):
            skipped_hidden += 1
            hidden_users.add(row["username"])
            continue  # hidden participation (admin/test account)

        seconds = row["seconds_since_start"]
        if seconds < 0:
            skipped_before_start += 1
            continue
        if seconds > duration_seconds:
            skipped_after_stop += 1
            continue

        seq += 1
        max_seen_seconds = max(max_seen_seconds, seconds)
        verdict = derive_verdict(
            row["score"], max_scores.get(task_id), row["compilation_outcome"], row["evaluation_outcome"]
        )
        username = row["username"]
        solutions[str(seq)] = {
            "user_id": username,
            "problem_index": indices[task_id]["problem_index"],
            "verdict": verdict,
            "submitted_seconds": seconds,
        }
        if username not in users:
            display_name = f"{row['first_name']} {row['last_name']}".strip() or username
            users[username] = {
                "name": display_name,
                "college": "",
                # Hidden participations never get here, but the frontend still
                # branches on this field, so keep emitting it.
                "is_exclude": False,
            }

    if skipped_before_start or skipped_after_stop:
        logger.info(
            "Dropped %d submission(s) before contest start and %d after contest stop "
            "(contest window is 0..%ds); they are kept in the backup but excluded "
            "from contest.json.",
            skipped_before_start, skipped_after_stop, duration_seconds,
        )

    excluded_users = sorted(hidden_users)
    if excluded_users:
        logger.info(
            "Dropped %d submission(s) from %d hidden participation(s): %s",
            skipped_hidden, len(excluded_users), ", ".join(excluded_users),
        )

    if frozen_second > max_seen_seconds:
        logger.warning(
            "frozen_second (%d) exceeds the latest submission's seconds_since_start "
            "(%d); nothing will appear frozen in the resolver UI.",
            frozen_second, max_seen_seconds,
        )

    contest_json = {
        "frozen_second": frozen_second,
        "problem_count": len(indices),
        "solutions": solutions,
        "users": users,
    }
    stats = {
        "contest_duration_seconds": duration_seconds,
        "submissions_included": len(solutions),
        "skipped_before_start": skipped_before_start,
        "skipped_after_stop": skipped_after_stop,
        "skipped_excluded_task": skipped_excluded_task,
        "skipped_hidden": skipped_hidden,
        "excluded_users": excluded_users,
    }
    return contest_json, stats


# ---------------------------------------------------------------------------
# Backup (dump) writer
# ---------------------------------------------------------------------------

def json_default(obj):
    if isinstance(obj, datetime.datetime):
        return obj.isoformat()
    raise TypeError(f"Not JSON serializable: {obj!r}")


def make_backup_dir(exports_dir, contest_name, contest_id):
    os.makedirs(exports_dir, exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.join(exports_dir, f"{slugify(contest_name)}_{contest_id}_{timestamp}")
    path = base
    suffix = 2
    while os.path.exists(path):
        path = f"{base}-{suffix}"
        suffix += 1
    os.makedirs(path)
    return path


def write_backup(backup_dir, meta, tasks, max_scores, sources, submissions):
    with open(os.path.join(backup_dir, "contest_meta.json"), "w") as f:
        json.dump(meta, f, indent=2, default=json_default, ensure_ascii=False)

    tasks_out = []
    for t in tasks:
        tasks_out.append({
            **t,
            "max_score": max_scores.get(t["id"]),
            "max_score_source": sources.get(t["id"]),
        })
    with open(os.path.join(backup_dir, "tasks.json"), "w") as f:
        json.dump(tasks_out, f, indent=2, default=json_default, ensure_ascii=False)

    csv_path = os.path.join(backup_dir, "submissions.csv")
    fieldnames = [
        "username", "first_name", "last_name", "hidden", "task_name", "submission_id",
        "submission_time", "seconds_since_start", "score", "compilation_outcome",
        "evaluation_outcome",
    ]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in submissions:
            writer.writerow({
                "username": row["username"],
                "first_name": row["first_name"],
                "last_name": row["last_name"],
                "hidden": row["hidden"],
                "task_name": row["task_name"],
                "submission_id": row["submission_id"],
                "submission_time": row["submission_time"].isoformat(),
                "seconds_since_start": row["seconds_since_start"],
                "score": row["score"],
                "compilation_outcome": row["compilation_outcome"],
                "evaluation_outcome": row["evaluation_outcome"],
            })

    logger.info("Backup written to %s", backup_dir)


def write_manifest(path, meta, indices, excluded_tasks, freeze_minutes=None, extra=None):
    manifest = {
        "generated_at": datetime.datetime.now().isoformat(),
        "contest_id": meta["id"],
        "contest_name": meta["name"],
        "problem_index_map": {
            str(v["problem_index"]): {"task_id": k, "name": v["name"], "title": v["title"]}
            for k, v in indices.items()
        },
        "excluded_tasks": excluded_tasks,
        "freeze_minutes_before_end": freeze_minutes,
    }
    if extra:
        manifest.update(extra)
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2, default=json_default, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Resolver writer
# ---------------------------------------------------------------------------

def write_resolver_json(contest_json, resolver_dir):
    tmp_path = os.path.join(resolver_dir, "contest.json.tmp")
    final_path = os.path.join(resolver_dir, "contest.json")
    with open(tmp_path, "w") as f:
        json.dump(contest_json, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, final_path)
    logger.info("Wrote %s", final_path)


# ---------------------------------------------------------------------------
# Serve (idempotent, PID-file based)
# ---------------------------------------------------------------------------

def pid_is_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def read_pid_file(pid_file):
    try:
        with open(pid_file) as f:
            data = json.load(f)
        return data["pid"], data["port"]
    except (OSError, ValueError, KeyError):
        return None, None


def write_pid_file(pid_file, pid, port):
    with open(pid_file, "w") as f:
        json.dump({"pid": pid, "port": port}, f)


def wait_for_exit(pid, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not pid_is_alive(pid):
            return
        time.sleep(0.1)


def port_in_use(port):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def serve_resolver(resolver_dir, port, admin_port):
    pid_file = os.path.join(resolver_dir, ".resolver_server.pid")
    log_file = os.path.join(resolver_dir, ".resolver_server.log")

    if os.path.exists(pid_file):
        pid, existing_port = read_pid_file(pid_file)
        if pid is not None and pid_is_alive(pid):
            if existing_port == port:
                logger.info("Resolver server already running (pid=%d) on port %d; reusing.", pid, port)
                return
            logger.info(
                "Stopping existing resolver server (pid=%d, port=%d) to restart on port %d.",
                pid, existing_port, port,
            )
            os.kill(pid, signal.SIGTERM)
            wait_for_exit(pid)

    if port_in_use(port):
        raise SystemExit(
            f"Port {port} is already in use by a process this script isn't tracking. "
            f"Pick a different --port."
        )

    server_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resolver_server.py")
    with open(log_file, "ab") as log_fh:
        proc = subprocess.Popen(
            [PYENV_PY, server_py, resolver_dir,
             "--port", str(port), "--admin-port", str(admin_port)],
            cwd=resolver_dir,
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    write_pid_file(pid_file, proc.pid, port)
    logger.info(
        "Started resolver server: http://localhost:%d/index.html (pid=%d, log=%s)",
        port, proc.pid, log_file,
    )
    logger.info(
        "Slide settings (this machine only): http://localhost:%d/admin.html",
        admin_port,
    )


# ---------------------------------------------------------------------------
# High-level steps
# ---------------------------------------------------------------------------

def do_dump(contest_id, exports_dir):
    conn = get_db_connection()
    try:
        meta = fetch_contest_meta(conn, contest_id)
        tasks = fetch_tasks(conn, contest_id)
        max_scores, sources = fetch_task_max_scores(conn, tasks)
        submissions = fetch_submissions(conn, contest_id)
    finally:
        conn.close()

    if not submissions:
        logger.warning("Contest %d has no submissions yet.", contest_id)

    backup_dir = make_backup_dir(exports_dir, meta["name"], contest_id)
    write_backup(backup_dir, meta, tasks, max_scores, sources, submissions)
    indices, excluded_tasks = assign_problem_indices(tasks, max_scores)
    write_manifest(os.path.join(backup_dir, "manifest.json"), meta, indices, excluded_tasks)
    return backup_dir


def load_backup(backup_dir):
    with open(os.path.join(backup_dir, "contest_meta.json")) as f:
        meta = json.load(f)
    meta["start"] = datetime.datetime.fromisoformat(meta["start"])
    meta["stop"] = datetime.datetime.fromisoformat(meta["stop"])

    with open(os.path.join(backup_dir, "tasks.json")) as f:
        tasks_out = json.load(f)
    tasks = [{k: t[k] for k in ("id", "num", "name", "title", "active_dataset_id")} for t in tasks_out]
    max_scores = {t["id"]: t["max_score"] for t in tasks_out}

    submissions = []
    with open(os.path.join(backup_dir, "submissions.csv"), newline="") as f:
        for row in csv.DictReader(f):
            submissions.append({
                "username": row["username"],
                "task_name": row["task_name"],
                "task_id": next(t["id"] for t in tasks if t["name"] == row["task_name"]),
                "submission_id": int(row["submission_id"]),
                "submission_time": datetime.datetime.fromisoformat(row["submission_time"]),
                "seconds_since_start": int(row["seconds_since_start"]),
                "score": float(row["score"]) if row["score"] not in ("", "None") else None,
                "compilation_outcome": row["compilation_outcome"] or None,
                "evaluation_outcome": row["evaluation_outcome"] or None,
                "first_name": row["first_name"],
                "last_name": row["last_name"],
                # Backups written before the 'hidden' column existed default to
                # visible, matching how they were converted at the time.
                "hidden": row.get("hidden", "").strip().lower() in ("true", "t", "1"),
            })
    return meta, tasks, max_scores, submissions


def do_convert(backup_dir, resolver_dir, freeze_minutes):
    meta, tasks, max_scores, submissions = load_backup(backup_dir)
    indices, excluded_tasks = assign_problem_indices(tasks, max_scores)
    contest_json, stats = build_contest_json(meta, submissions, indices, max_scores, freeze_minutes)
    write_resolver_json(contest_json, resolver_dir)
    write_manifest(
        os.path.join(resolver_dir, "contest.manifest.json"),
        meta, indices, excluded_tasks, freeze_minutes=freeze_minutes,
        extra={"source_backup": backup_dir, "conversion_stats": stats},
    )
    return contest_json


def most_recent_backup(exports_dir, contest_id):
    candidates = []
    if os.path.isdir(exports_dir):
        for name in os.listdir(exports_dir):
            path = os.path.join(exports_dir, name)
            manifest_path = os.path.join(path, "manifest.json")
            if os.path.isdir(path) and os.path.isfile(manifest_path):
                with open(manifest_path) as f:
                    manifest = json.load(f)
                if manifest.get("contest_id") == contest_id:
                    candidates.append((os.path.getmtime(path), path))
    if not candidates:
        raise SystemExit(
            f"No existing backup found for contest_id={contest_id} under {exports_dir}. "
            f"Run the 'dump' step first."
        )
    candidates.sort()
    return candidates[-1][1]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument("--contest-id", type=int, default=None,
                         help="required for dump/convert/all; unused by serve")
    parent.add_argument("--exports-dir", default=DEFAULT_EXPORTS_DIR)
    parent.add_argument("--resolver-dir", default=DEFAULT_RESOLVER_DIR)
    parent.add_argument("--freeze-minutes-before-end", type=int, default=DEFAULT_FREEZE_MINUTES)
    parent.add_argument("--port", type=int, default=DEFAULT_PORT)
    parent.add_argument("--admin-port", type=int, default=DEFAULT_PORT + 1,
                        help="localhost-only port for the slide settings page")
    parent.add_argument("-v", "--verbose", action="store_true")

    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("dump", parents=[parent], help="Export current CMS submissions to a timestamped backup folder.")

    p_convert = sub.add_parser("convert", parents=[parent], help="Convert a backup folder into ioi-resolver's contest.json.")
    p_convert.add_argument("--from-backup", default=None, help="Backup folder to convert (default: most recent for --contest-id).")

    sub.add_parser("serve", parents=[parent], help="Start/reuse the static HTTP server for ioi-resolver.")

    p_all = sub.add_parser("all", parents=[parent], help="dump -> convert -> serve (default).")
    p_all.add_argument("--dump-only", action="store_true")
    p_all.add_argument("--no-serve", action="store_true")

    # Allow bare `export_to_resolver.py --contest-id 2` (no subcommand) to mean "all".
    parser.add_argument("--contest-id", type=int, dest="contest_id_top", help=argparse.SUPPRESS)
    return parser, parent


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    known_commands = {"dump", "convert", "serve", "all"}
    if not argv or argv[0] not in known_commands:
        argv = ["all"] + argv

    parser, _ = build_arg_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if args.command != "serve" and args.contest_id is None:
        raise SystemExit(f"--contest-id is required for '{args.command}'.")

    if args.command == "dump":
        backup_dir = do_dump(args.contest_id, args.exports_dir)
        print(f"Backup written to: {backup_dir}")

    elif args.command == "convert":
        backup_dir = args.from_backup or most_recent_backup(args.exports_dir, args.contest_id)
        do_convert(backup_dir, args.resolver_dir, args.freeze_minutes_before_end)
        print(f"contest.json written to: {os.path.join(args.resolver_dir, 'contest.json')}")

    elif args.command == "serve":
        serve_resolver(args.resolver_dir, args.port, args.admin_port)

    elif args.command == "all":
        backup_dir = do_dump(args.contest_id, args.exports_dir)
        print(f"Backup written to: {backup_dir}")
        if args.dump_only:
            return
        do_convert(backup_dir, args.resolver_dir, args.freeze_minutes_before_end)
        print(f"contest.json written to: {os.path.join(args.resolver_dir, 'contest.json')}")
        if not args.no_serve:
            serve_resolver(args.resolver_dir, args.port, args.admin_port)
            print(f"Resolver running at: http://localhost:{args.port}/index.html")
        print(
            "Reminder: if the resolver was already open in a browser, click "
            "'Reset standings' (or clear localStorage keys icpc-ranks/operation-flag) "
            "to see the freshly generated data."
        )


if __name__ == "__main__":
    main()
