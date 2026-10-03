---
name: verify
description: Run functions/ml research CLIs (delta_hedge.py, plot_delta_hedge.py, gex_vol_study.py, ...) against real data without clobbering the user's outputs.
---

# Verifying functions/ml changes

The surface is the CLI scripts. They write to `HERE/data/<study>/` and `HERE/plots/` (paths from
`Path(__file__)`), so running them in place OVERWRITES the user's full-history parquets and the
tracked PNGs. Run from a sandbox copy instead:

```bash
S=<scratchpad>/sbx; ML=/Users/sunnychen/Developper/PersonalProjects/azure-market-data/functions/ml
mkdir -p $S/ml/data $S/GEXCalculator
cp $ML/*.py $S/ml/; cp $ML/../GEXCalculator/*.py $S/GEXCalculator/   # gex_vol_study imports GEXCalculator
for d in thetadata databento thetadata_gex; do ln -s $ML/data/$d $S/ml/data/$d; done   # inputs only
cd $S/ml && $ML/.venv/bin/python <script>.py ...
```

## Runtimes (M-series, workers 6)
- `delta_hedge.py --symbol QQQ --dte 0`: ~5s full history (two passes: smile beta, then hedges)
- `delta_hedge.py ... --frontier --costs 0.5,1,2`: ~18s per config (2,000-draw bootstrap)
- `plot_delta_hedge.py [--frontier]`: seconds; PNGs are deterministic, `cmp` against `$ML/plots/`
- `gex_vol_study.py --rebuild --perms 49`: ~1–2 min per symbol. `--perms 0` (all ~1,150 shifts)
  is ~25 min; point estimates and bootstrap CIs don't depend on `--perms`, only the p floor does.

## Useful checks
- The deterministic outputs (parquets, PNGs, rebuilt `frame_<sym>.parquet`) should be
  bit-identical to the user's in `$ML/data/...`: use `DataFrame.equals` / `cmp`.
- README tables in `functions/ml/README.md` are the claims to check against the printed tables.
- `--start/--end` windows are fine for smoke runs, but the smile beta needs 20 prior days
  in-window, and frontier bootstraps with fewer than BOOT_BLOCK (20) days collapse to zero-width
  CIs.
