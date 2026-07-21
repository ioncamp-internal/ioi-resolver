# ioi-resolver

Legacy Vue 1.x + jQuery app with no build step. Edit `index.html`, `js/main.js`,
`hiho-resolver.js` and `css/main.css` directly — the server serves them as-is.

## Shipping a change

- After editing `js/`, `css/` or `hiho-resolver.js`, **bump the `?v=` on all three tags in
  `index.html`**. Cloudflare edge-caches `.js`/`.css` for 4h while HTML and JSON pass
  through uncached, so the version bump is what actually delivers the change.
- Verify against the public URL, not just disk. `cf-cache-status: MISS` means it came from
  origin; also compare md5 with the local file:
  `curl -sS -D - -o /tmp/x.js "https://judge.ioncamp.org/resolver/js/main.js?v=N" | grep -i cf-cache-status`
- Replacing a slide image needs `slides.json`'s `version` bumped, for the same reason.
- "HTML and JSON pass through uncached" is true of **Cloudflare only**. The origin is a plain
  `python -m http.server`, which sends no `Cache-Control`, so the *browser* falls back to
  heuristic freshness off `Last-Modified` — a days-old file stays "fresh" for hours. That is
  why `contest.json` and `slides.json` are fetched with `$.ajax({cache: false})` (jQuery
  appends `_=timestamp`) and not `$.getJSON`. Don't tidy that back; it is what makes a
  re-exported `contest.json` or an edited `slides.json` reach the screen at all.
- `index.html` itself is subject to that same heuristic cache, and it is what carries the
  `?v=` stamps — so after a bump the first load still needs one hard-refresh
  (`Ctrl+Shift+R`) before the new `js/css` is even requested.

## Data

- `contest.json` is generated. `resolver-export/export_to_resolver.py convert` writes it
  as `.tmp` then `os.replace()`, so **any hand-edited key is destroyed on the next
  convert**. Hand-authored config belongs in its own file — that is why `slides.json`
  exists rather than extra keys in `contest.json`.
- Hidden CMS participations (admin/test accounts) are dropped at export. They used to be
  kept and flagged `is_exclude`, which let a test account take first-to-solve away from
  the team that earned it.
- **A submission's exported score is the team's running task total, not that submission's
  own score.** CMS `score_mode = max_subtask` (the IOI 2017 rule, what this contest uses)
  keeps the best result *per subtask* across submissions and sums them, so a team can hold
  a score no single submission ever achieved (19, then 13, then 44 scores 63). Exporting
  raw per-submission scores silently under-reported those teams — the resolver takes the
  max over submissions, so it topped out at 44 — and moved real teams down the standings.
  `accumulate_score()` folds each submission into a per-`(team, task)` accumulator;
  `score_mode` comes from `tasks.score_mode` and anything other than `max_subtask`
  degrades to `max`.
- The backup's `subtask_scores` column is a compact `{idx: points}` dict, *not* CMS's raw
  `score_details` list — `subtask_scores()` parses the latter, `parse_subtask_column()` the
  former. Feeding one to the other returns `None` and silently degrades the whole contest
  to `max`. Backups predating the column have no details and legitimately fall back.
- Sanity-check a fresh `contest.json` against CMS's own scoreboard export (the RWS CSV)
  cell by cell, not just on totals. Equal-score teams can still order differently — that is
  the resolver's own tie-break (see below), not a scoring bug.
- Tests: `python3 resolver-export/test_export_to_resolver.py` (run from the repo root; the
  conversion logic is pure, so any Python 3 works). The exporter's `dump` subcommand talks
  to CMS and needs that environment's own interpreter.

## Ranking / tie-break

- Standings order is decided **only** in `hiho-resolver.js`. The frontend never sorts — it
  just follows each `op.new_rank`. Change ordering there, never in `js/main.js`.
- Tie-break lives in `cmpRank`/`betterRank`, used in **both** the initial sort and the reveal
  bubble: **score desc → AC (full-solve, verdict `AC`) count desc → `reach_time` asc**, where
  `reach_time` is the time the team reached its current total (the max achieve-time among its
  counted submissions; earlier wins). Each `rank[user]` carries `ac_count`/`reach_time`,
  frozen-initialised (`frozenAchieve`/`frozenHasAC`) then updated as the reveal opens each
  problem — exactly mirroring how `score` is maintained. Per-`(team,problem)` achieve times
  come from `this.finalAchieve`, precomputed once from `solutions`.
- Equal-score teams therefore get **distinct** ranks; there is deliberately no "same score =>
  same rank" collapse. `setRank` in `js/main.js` is an intentional no-op — don't reinstate it.
- Verify with the node stub (see below): build a `(score, ac_count, reach_time)` oracle
  straight from `solutions`, sort by the same rule, and assert it equals `final_row`.

## Reveal internals

- **The rank movement does not converge bottom-up.** A team can rise and then be overtaken
  by a team resolved later, so its rank is *not* final when its own last flip ends. Use
  `Resolver.settlePoints()` / `buildSettleQueue()` to know a team is done; `op.new_rank` is
  its position at that moment, not its final one.
- **The settle stops, by contrast, are strictly bottom-up and every team gets exactly one.**
  `settlePoints()` scans rows bottom-up carrying a running max, so a team's stop is
  `max(its own last flip/displacement, every stop below it)`. That single rule covers two
  things that each broke the show:
  - a team with no post-freeze submissions that also never gets displaced owns no `op`, so
    it has nothing to key a stop on and was silently never focused (5 of 25 teams on the
    real contest). It now inherits the stop from below; an untouched *bottom* block falls
    back to the first stop overall.
  - a team can stop moving while the teams below it are still swapping. Confirming it then
    made the focus skip rows and fold back down.

  Don't "optimise" this back to each team's own last op. Regression test:
  `node test_settle_queue.js` (synthetic data, so it runs without `contest.json`).
- When a team rises further than one screen height, `distance` is clamped so the row
  deliberately flies off the top and the re-render puts it back. Anything that reacts to a
  team arriving must scroll that row into view first, or it fires at an empty screen.
- `document.onkeydown` is a property assignment — extend the existing handler, never add a
  second one.
- A CSS `animation: ... infinite` toggled from JS must be left on for whole cycles, and
  `rotating` must complete a full 360°; stopping at 180° ends with the card face-down and
  snapping back.

## Checking frontend logic without a browser

`hiho-resolver.js` runs under node with a small stub. This is how the settle-point bug
above was found — drive it against the real `contest.json` and assert on the result
rather than eyeballing the animation.

```js
const $ = () => ({ find: () => ({ text: () => '' }) });
$.extend = (deep, target, src) => JSON.parse(JSON.stringify(src));
global.$ = $; global.sleep = ms => new Promise(r => setTimeout(r, ms));
eval(require('fs').readFileSync('hiho-resolver.js', 'utf8'));

const r = new Resolver(data.solutions, data.users, data.problem_count, data.frozen_second);
r.calcOperations(); r.buildSettleQueue(); r.resolveSlides(cfg);
```
