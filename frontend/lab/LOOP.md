# Overnight lab loop — instructions for Claude

You are running unattended. Nobody will answer questions until morning. Work
only inside `frontend/lab/`, and never commit, push or touch the network.

All paths and commands below are relative to `frontend/`. The shell's working
directory persists between commands and between iterations, so check `pwd`
and `cd frontend` only if you are not already there (a second `cd frontend`
fails).

If the /loop prompt names a night (e.g. `--night rehearsal`), append that flag
to every `run`, `status` and `finalize` command below. Otherwise the night is
the default, named for the evening the run started.

## Each iteration

1. `node scripts/strategy-lab.mjs status`
   - If `finalized` is true: stop the loop (ScheduleWakeup `stop: true`).
   - If `shouldFinalize` is true: go to **Morning**.
2. Read `lab/AGENDA.md`, the last ~40 lines of `lab/runs/JOURNAL.md`, and
   `node scripts/strategy-lab.mjs leaderboard`. JOURNAL.md does not exist before
   the first night; create it with a `# Strategy lab journal` heading.
3. Write **3–5 new specs** in `lab/strategies/`, from the next unticked agenda
   family (or a **Discovered** one). Each spec:
   - has a kebab-case `id` equal to its filename, and a `rationale` that names
     the market mechanism being tested, not just the rule;
   - has at most 36 grid cells, with values spread coarsely (e.g. 0.25/0.5/1,
     not 0.45/0.5/0.55). Fine grids buy in-sample Sharpe with deflation;
   - reads only the past (the harness rejects look-ahead);
   - prefers `.json` rule-AST specs; use `.js` only when the idea needs
     arithmetic, state, or multi-bar logic. Examples of both are already in
     `lab/strategies/`.
4. `node scripts/strategy-lab.mjs run lab/strategies/<new files…>`
   - A spec that errors: fix it if it's a bug in the spec (a new id is not
     needed for a spec that never reached the ledger), otherwise note it and
     move on.
5. Append to `lab/runs/JOURNAL.md` (under a `## Night <night>` heading, added
   on the night's first iteration): a `### <time> — <family>` heading, one
   line per spec (id, score, the key number, what it rules out or suggests),
   and one sentence on what to try next. Tick the agenda family when it has
   ≥ 3 specs, and add to **Discovered** if a result suggests a new family.
6. ScheduleWakeup ~90s with the same /loop prompt.

## Honesty rules

- Never re-run a spec under a new id with only cosmetic changes, and never
  widen a grid around a winner just to push its score up. A follow-up spec
  must change the *mechanism* (a new gate, a new exit, the opposite side) and
  say so in its rationale.
- Read every score against `control-random-entry`. A spec that doesn't clearly
  beat the control on both symbols has found nothing.
- Don't try to reach the holdout. There's no command for it except
  `finalize`, and that runs once per night.
- Never run `verify`, and never read anything under `functions/ml/data/`:
  the sealed verify block and its log live there. Verifying a finalist is a
  human decision made in the morning, once per spec, ever.

## Morning (budget spent, or past 06:30)

1. `node scripts/strategy-lab.mjs finalize` (it writes
   `lab/runs/<night>/REPORT.md`, `preregistered.json`, `holdout.json`).
2. Append a **Morning summary** to `lab/runs/JOURNAL.md`: families covered,
   the noise floor from the control, what reached finalize and how it held up
   on the holdout, and the 2–3 families most worth another night.
3. Stop the loop (ScheduleWakeup `stop: true`).
