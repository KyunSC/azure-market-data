"""Four-panel summary of a delta_hedge.py run (aggregates only; no quotes or per-day rows plotted).

  a) hedged P&L (5m variant) vs entry IV - realized vol: decile-bin means +/- 2 SE, OLS line on all days
  b) mean Greek attribution of the short straddle ($/straddle), incl. second-order terms and costs
  c) P&L std by hedge variant: the variance cost of hedging less often (and what charm/smile buy back)
  d) cumulative P&L for CUM_VARIANTS (after spread and hedge costs)

Reads data/delta_hedge/<sym>_dte<d>.parquet, writes plots/delta_hedge_<sym>_dte<d>.png.

--frontier: cost-vs-risk frontier from data/delta_hedge/frontier_<sym>_dte<d>.parquet, one column
per hedge cost (0.5 / 1 / 2 bp): top row daily P&L std, bottom row CVaR 5%, both against mean hedge
cost on a log axis (straight segments = the log-cost interpolation used for the matched-cost gaps).
Clock schedules, fixed bands and WW bands are one connected series each; entry-only is off-scale
and left out. Writes plots/delta_hedge_frontier_<sym>_dte<d>.png.

Run: .venv/bin/python plot_delta_hedge.py --symbol QQQ --dte 0
     .venv/bin/python plot_delta_hedge.py --symbol QQQ --dte 0 --frontier
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from delta_hedge import OUT_DIR, frontier_summary, summarize

PLOTS_DIR = Path(__file__).resolve().parent / "plots"
SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
# Categorical slots in fixed order (dataviz reference palette, light mode); color follows the variant.
VARIANT_COLORS = {"5m": "#2a78d6", "30m": "#eb6834", "60m": "#1baf7a", "60m+charm": "#eda100",
                  "5m+smile": "#e87ba4", "60m+smile": "#008300", "entry-only": "#4a3aa7", "none": "#e34948"}
CUM_VARIANTS = ["5m", "30m", "60m", "60m+smile", "none"]  # panel d; the rest overlap these lines
POINT, BAR = "#2a78d6", "#8a8984"  # panel a markers; attribution bars (sign is the bar's direction)
# Frontier families on categorical slots 1-3 (validated all-pairs; aqua < 3:1, so every series is
# direct-labelled). Labelled points: clocks by interval, a few band widths / WW scales.
FAMILY_COLORS = {"clock": "#2a78d6", "band": "#eb6834", "ww": "#1baf7a"}
FAMILY_LABELS = {"clock": "clock (5m ... 120m)", "band": "fixed band (shares)", "ww": "WW band (scale c)"}
CLOCK_LABELS = ("5m", "15m", "30m", "60m", "120m")
BAND_LABELS = {"band": ((10, 30, 80), "{:g} sh"), "ww": ((2, 6, 24), "c={:g}")}


def _style(ax, title):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=10.5, color=INK)
    ax.tick_params(colors=INK2, labelsize=8.5)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.grid(color=GRID, lw=0.6)
    ax.set_axisbelow(True)


def plot(df: pd.DataFrame, symbol: str, dte: int, out: Path) -> None:
    s = summarize(df)
    fig, axes = plt.subplots(2, 2, figsize=(13, 9), facecolor=SURFACE)
    days = df["date"].nunique()
    fig.suptitle(f"{symbol} short ATM straddle, DTE {'0' if dte == 0 else f'>={dte}'}, delta-hedged "
                 f"intraday: {days} days {df['date'].min()}..{df['date'].max()} (bid/ask fills, 0.5 bp hedge cost)",
                 x=0.01, ha="left", fontsize=11.5, color=INK)

    # a) P&L vs IV - RV
    ax = axes[0, 0]
    x5 = df[df["variant"] == "5m"]
    spread = 100 * (x5["entry_iv"] - x5["rv"])
    bins = pd.qcut(spread, 10, duplicates="drop")
    g = x5["pnl"].groupby(bins, observed=True)
    mid = spread.groupby(bins, observed=True).mean()
    se = g.std() / np.sqrt(g.count())
    ax.errorbar(mid, g.mean(), yerr=2 * se, fmt="o", ms=6, color=POINT, ecolor=POINT, elinewidth=1.2, capsize=0,
                label="decile mean ± 2 SE")
    b1, b0 = np.polyfit(spread, x5["pnl"], 1)
    xs = np.linspace(mid.min(), mid.max(), 50)
    r2 = np.corrcoef(spread, x5["pnl"])[0, 1] ** 2
    ax.plot(xs, b0 + b1 * xs, color=INK2, lw=1.5, ls="--", label=f"OLS all days: ${b1:.1f} per vol pt, R²={r2:.2f}")
    ax.axhline(0, color=INK2, lw=0.8)
    ax.axvline(0, color=INK2, lw=0.8)
    ax.set_xlabel("entry implied vol − realized vol (vol points)", color=INK2, fontsize=9)
    ax.set_ylabel("hedged P&L, 5-min rebalance ($/straddle)", color=INK2, fontsize=9)
    ax.legend(fontsize=8, frameon=False, labelcolor=INK)
    _style(ax, "a) Short-vol P&L follows the implied−realized spread")

    # b) attribution (option terms are hedge-independent; costs from the 5m variant)
    ax = axes[0, 1]
    r = s.loc["5m"]
    parts = {"theta": r["theta"], "gamma": r["gamma"], "vega": r["vega"],
             "vanna": x5["vanna"].mean(), "volga": x5["volga"].mean(), "charm": x5["charm"].mean(),
             "residual": r["res2"], "spread + hedge cost": -r["costs"]}
    names, vals = list(parts), np.array(list(parts.values()))
    y = np.arange(len(names))[::-1]
    ax.barh(y, vals, height=0.62, color=BAR, edgecolor=SURFACE, linewidth=2)
    for yi, v in zip(y, vals):
        ax.text(v + (4 if v >= 0 else -4), yi, f"{v:+.1f}", va="center", ha="left" if v >= 0 else "right",
                fontsize=8.5, color=INK)
    ax.set_yticks(y, names)
    ax.axvline(0, color=INK2, lw=0.8)
    lim = np.abs(vals).max() * 1.3
    ax.set_xlim(-lim, lim)
    ax.set_xlabel(f"mean $/straddle (net: {r['mean']:+.1f}; 2nd-order terms cut |residual| "
                  f"{100 * r['res_red']:.0f}%)", color=INK2, fontsize=9)
    _style(ax, "b) Mean Greek attribution of the short straddle")
    ax.grid(axis="y", visible=False)

    # c) std by variant
    ax = axes[1, 0]
    order = [v for v in VARIANT_COLORS if v in s.index]
    stds = s.loc[order, "std"]
    ax.bar(range(len(order)), stds, width=0.62, color=[VARIANT_COLORS[v] for v in order],
           edgecolor=SURFACE, linewidth=2)
    base = s.loc["none", "std"] ** 2
    for i, v in enumerate(order):
        chg = 100 * (stds[v] ** 2 / base - 1)
        ax.text(i, stds[v] + stds.max() * 0.015, f"{stds[v]:.0f}" + (f"\n{chg:+.0f}%".replace("-", "−") if v != "none" else ""),
                ha="center", va="bottom", fontsize=8.5, color=INK)
    ax.set_xticks(range(len(order)), order, rotation=25, ha="right", rotation_mode="anchor")
    ax.set_ylim(0, stds.max() * 1.22)
    ax.set_ylabel("daily P&L std ($/straddle)", color=INK2, fontsize=9)
    ax.grid(axis="x", visible=False)
    _style(ax, "c) Hedging less often costs variance (variance change vs unhedged)")

    # d) cumulative P&L
    ax = axes[1, 1]
    for v in [v for v in CUM_VARIANTS if v in s.index]:
        x = df[df["variant"] == v].sort_values("date")
        ax.plot(pd.to_datetime(x["date"]), x["pnl"].cumsum(), color=VARIANT_COLORS[v], lw=2 if v == "5m" else 1.4,
                label=f"{v}  (Sharpe {s.loc[v, 'sharpe']:.1f})")
    ax.axhline(0, color=INK2, lw=0.8)
    ax.set_ylabel("cumulative P&L ($, 1 straddle/day)", color=INK2, fontsize=9)
    ax.legend(fontsize=8, frameon=True, facecolor=SURFACE, edgecolor=GRID, framealpha=0.9, labelcolor=INK, ncol=2, loc="best")
    _style(ax, "d) Cumulative P&L by hedge variant, net of costs")

    fig.tight_layout(rect=(0, 0, 1, 0.96))
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=140, facecolor=SURFACE)
    plt.close(fig)


def _point_labels(ax, x, y, texts, color, above: bool, right: bool = False) -> None:
    """Small text labels offset above or below (and optionally right of) their points, in ink, haloed
    in the surface colour and drawn over the lines so a crossing series never hides them."""
    for xi, yi, t in zip(x, y, texts):
        ax.annotate(t, (xi, yi), xytext=(5 if right else 0, (4 if right else 7) * (1 if above else -1)),
                    textcoords="offset points", ha="left" if right else "center",
                    va="bottom" if above else "top", fontsize=7.5, color=color, zorder=5,
                    path_effects=[pe.withStroke(linewidth=2.5, foreground=SURFACE)])


def plot_frontier(df: pd.DataFrame, symbol: str, dte: int, out: Path) -> None:
    s = frontier_summary(df)
    costs = sorted(s["cost_bps"].unique())
    fig, axes = plt.subplots(2, len(costs), figsize=(5.2 * len(costs), 9), facecolor=SURFACE, squeeze=False)
    fig.suptitle(f"{symbol} short ATM straddle, DTE {'0' if dte == 0 else f'>={dte}'}: hedge cost vs risk, clock "
                 f"schedules vs delta bands, {df['date'].nunique()} days {df['date'].min()}..{df['date'].max()} "
                 "(bid/ask fills, BS delta, per straddle)", x=0.01, ha="left", fontsize=11.5, color=INK)
    for col, bps in enumerate(costs):
        x = s[s["cost_bps"] == bps]
        fam = x[x["kind"].str.endswith("@clock")].set_index("variant")
        for row, (metric, ylab) in enumerate((("std", "daily P&L std ($/straddle)"),
                                               ("cvar5", "CVaR 5%, mean of worst 5% of days ($)"))):
            ax = axes[row, col]
            for kind, color in FAMILY_COLORS.items():
                f = x[(x["kind"] == kind) & (x["variant"] != "entry-only")].sort_values("cost")
                ax.plot(f["cost"], f[metric], color=color, lw=2, marker="o", ms=5.5, mec=SURFACE, mew=1.5,
                        label=FAMILY_LABELS[kind], zorder=3, solid_joinstyle="round", solid_capstyle="round")
                if kind == "clock":
                    lab = f[f["variant"].isin(CLOCK_LABELS)]
                    # the clock is the outer (upper/lower-right) curve: label into the empty side
                    _point_labels(ax, lab["cost"], lab[metric], lab["variant"], INK2, above=metric == "std", right=True)
                else:  # WW sits below the fixed bands on std and above them on CVaR: label outward
                    params, fmt = BAND_LABELS[kind]
                    lab = f[f["param"].isin(params)]
                    _point_labels(ax, lab["cost"], lab[metric], [fmt.format(p) for p in lab["param"]], INK2,
                                  above=(kind == "band") == (metric == "std"))
            ax.set_xscale("log")
            ax.xaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:g}"))
            ax.xaxis.set_minor_formatter(plt.FuncFormatter(lambda v, _: f"{v:g}" if str(round(v))[0] in "25" else ""))
            ax.set_xlabel("mean hedge cost ($/straddle/day, log scale)", color=INK2, fontsize=9)
            if col == 0:
                ax.set_ylabel(ylab, color=INK2, fontsize=9)
            ax.margins(x=0.08, y=0.1)
            if row == 0:
                lines = []
                for k in ("band", "ww"):
                    key = f"{k}@30m"
                    if key in fam.index and np.isfinite(fam.loc[key, "std_gap"]):
                        r = fam.loc[key]
                        lines.append(f"{'fixed' if k == 'band' else 'WW'} band: {r['std_gap']:+.1f} "
                                     f"({r['std_gap_pct']:+.0f}%)\n   95% CI {r['gap_lo']:+.1f}..{r['gap_hi']:+.1f}"
                                     .replace("-", "−"))
                if lines:  # upper right = expensive and risky: dominated, so no data there
                    ax.text(0.98, 0.97, "std vs 30m clock at its cost\n" + "\n".join(lines), transform=ax.transAxes,
                            ha="right", va="top", linespacing=1.3,
                            fontsize=7.5, color=INK, bbox=dict(facecolor=SURFACE, edgecolor=GRID, boxstyle="round,pad=0.4"))
                _style(ax, f"{'abc'[col]}) {bps:g} bp per hedge trade: P&L std")
            else:
                ax.legend(fontsize=8, frameon=True, facecolor=SURFACE, edgecolor=GRID, framealpha=0.9,
                          labelcolor=INK, loc="lower right")
                _style(ax, f"{'def'[col]}) {bps:g} bp per hedge trade: left tail")
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=140, facecolor=SURFACE)
    plt.close(fig)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="QQQ")
    ap.add_argument("--dte", type=int, default=0)
    ap.add_argument("--frontier", action="store_true", help="plot the cost-vs-risk frontier instead")
    args = ap.parse_args()
    sym = args.symbol.lower()
    if args.frontier:
        path = OUT_DIR / f"frontier_{sym}_dte{args.dte}.parquet"
        if not path.exists():
            print(f"missing {path}; run delta_hedge.py --symbol {args.symbol} --dte {args.dte} --frontier first")
            return 2
        out = PLOTS_DIR / f"delta_hedge_frontier_{sym}_dte{args.dte}.png"
        plot_frontier(pd.read_parquet(path), args.symbol.upper(), args.dte, out)
        print(f"wrote {out}")
        return 0
    path = OUT_DIR / f"{sym}_dte{args.dte}.parquet"
    if not path.exists():
        print(f"missing {path}; run delta_hedge.py --symbol {args.symbol} --dte {args.dte} first")
        return 2
    out = PLOTS_DIR / f"delta_hedge_{sym}_dte{args.dte}.png"
    plot(pd.read_parquet(path), args.symbol.upper(), args.dte, out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
