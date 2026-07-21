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

## Data

- `contest.json` is generated. `resolver-export/export_to_resolver.py convert` writes it
  as `.tmp` then `os.replace()`, so **any hand-edited key is destroyed on the next
  convert**. Hand-authored config belongs in its own file — that is why `slides.json`
  exists rather than extra keys in `contest.json`.
- Hidden CMS participations (admin/test accounts) are dropped at export. They used to be
  kept and flagged `is_exclude`, which let a test account take first-to-solve away from
  the team that earned it.
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

- **The reveal does not strictly converge bottom-up.** A team can rise and then be
  overtaken by a team resolved later, so its rank is *not* final when its own last flip
  ends. Use `Resolver.settlePoints()` / `buildSettleQueue()` to know a team is done;
  `op.new_rank` is its position at that moment, not its final one.
- **Every team gets a settle stop, including ones with no operation of their own.** A team
  with zero post-freeze submissions that also never gets displaced owns no `op`, so it has
  nothing to key a stop on; `settlePoints()` borrows the last settle op of the teams below
  it (and the first stop overall for an untouched bottom block). Without that they were
  silently never focused — 5 of 25 teams on the real contest. Regression test:
  `node test_settle_queue.js`.
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
