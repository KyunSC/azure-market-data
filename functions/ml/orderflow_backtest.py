"""Backtest the Flow Zone Trader "delta bubble at a key level" setup on NQ tick data.

Rules, transcribed from the channel's "Delta Volume Bubbles orderflow trading strategy"
video (youtube.com/watch?v=NMoT47nml_k):

  * No key level, no trade. Levels: prior-session low-volume nodes (volume profile),
    prior-session high/low, and the session VWAP +-1/2 sd bands.
  * Short: price comes up into a level from below, a *buy* delta bubble (one aggressor
    order of >= bubble_size contracts) prints at the level, then price trades back below
    the bubble with acceptance (the next full minute closes below its lowest fill): buyers are
    underwater / absorbed. Long is the mirror image with a sell bubble.
  * Stop above structure (the extreme since the bubble). Target the next key level or
    VWAP; skip the trade if that is less than 1R away, and use 2R when nothing is in
    the way.
  * Optional footprint confirmation: the accepting minute's delta must agree with the
    trade (aggressive sellers stepping in for a short).

Not modelled: the video's discretionary footprint read beyond minute delta, the Globex
"daily open" level (the data starts at 09:25 ET), and sizing down on wide stops (trades
wider than max_stop are skipped; results are in R, so size does not matter).

Everything is causal: levels come from the prior session or from prints before the
trigger, and entries fill at the first print after the confirming minute closes, one
tick worse. Stops fill one tick worse too; targets need a print one tick through.

Evaluation: an 8-cell grid chosen on the first 70% of sessions (discovery) and
reported on the rest (holdout), next to controls with identical levels, stops and
targets: "touch" (any print at the level, no bubble), "with_flow" (the bubble is on
the trade's side, so no absorption story) and random entries (noise floor).

Data: data/databento/nq-trades/NQ/*.parquet (databento_fetch.py nq-trades), all of it
before the sealed verify block.

    .venv/bin/python functions/ml/orderflow_backtest.py
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, replace
from pathlib import Path

import numpy as np
import pandas as pd

from holdout import VERIFY_START

ET = "America/New_York"
TICK = 0.25
POINT_VALUE = 20.0  # NQ $ per point
COMMISSION_PTS = 4.5 / POINT_VALUE  # round trip, NQ
SLIP = TICK  # adverse slippage on market entries, stops and the end-of-day exit
MIN_NS = 60_000_000_000
DATA = Path(__file__).resolve().parent / "data" / "databento" / "nq-trades" / "NQ"
OUT = Path(__file__).resolve().parent / "data" / "orderflow"
DISCOVERY_FRAC = 0.7


@dataclass(frozen=True)
class Params:
    trigger: str = "absorb"  # "absorb" | "with_flow" | "touch" | "random"
    bubble_size: int = 60  # contracts in one aggressor order (the video uses 60-100)
    level_tol: float = 3.0  # points between the bubble and the level
    footprint: bool = False
    approach_min: int = 5  # price this long before the trigger must be on the approach side
    confirm_min: int = 10  # acceptance must come within this many minutes
    min_stop: float = 4.0
    max_stop: float = 30.0
    min_rr: float = 1.0
    fallback_rr: float = 2.0
    stop_buffer: float = 2 * TICK
    band_after_min: int = 15  # VWAP bands are degenerate right after the open
    last_entry_min: int = 360  # 15:30 ET
    flatten_min: int = 385  # 15:55 ET
    seed: int = 0

    @property
    def name(self) -> str:
        if self.trigger == "random":
            return f"random/s{self.seed}"
        size = "" if self.trigger == "touch" else f"/b{self.bubble_size}"
        return f"{self.trigger}{size}/tol{self.level_tol:g}/{'fp' if self.footprint else 'nofp'}"


@dataclass
class Session:
    """Prior-session reference levels; only valid on the same contract (no roll gap)."""
    instrument: int
    high: float
    low: float
    lvns: list[float]


@dataclass
class Day:
    date: str
    instrument: int
    open_ns: int
    ts: np.ndarray  # int64 ns UTC, 09:25-16:00 ET prints
    px: np.ndarray
    sz: np.ndarray
    side: np.ndarray  # +1 buy aggressor, -1 sell aggressor, 0 unknown
    rth0: int  # first print at/after 09:30
    vwap: np.ndarray  # after print i (NaN before rth0)
    sd: np.ndarray
    bounds: np.ndarray  # print index at each minute boundary 09:30 + k min, k = 0..390
    close: np.ndarray  # per minute, carried forward over empty minutes
    delta: np.ndarray
    o_start: np.ndarray  # aggregated aggressor orders
    o_end: np.ndarray
    o_size: np.ndarray
    o_lo: np.ndarray
    o_hi: np.ndarray
    o_side: np.ndarray


def aggregate_orders(ts, px, sz, side):
    """One aggressor order sweeping several prices prints as several trades with the same
    match timestamp; group consecutive prints with equal (ts, side) back into orders."""
    new = np.ones(len(ts), bool)
    new[1:] = (ts[1:] != ts[:-1]) | (side[1:] != side[:-1])
    start = np.flatnonzero(new)
    end = np.r_[start[1:], len(ts)] - 1
    size = np.add.reduceat(sz, start)
    return start, end, size, np.minimum.reduceat(px, start), np.maximum.reduceat(px, start), side[start]


def low_volume_nodes(px, sz, bin_pts=5.0, win=3, reach=10, ratio=0.5) -> list[float]:
    """Valleys of the session volume profile: the local minimum of a smoothed histogram
    over +-win bins, at most `ratio` of the smaller peak within `reach` bins either side."""
    if len(px) == 0:
        return []
    b = np.floor(px / bin_pts).astype(np.int64)
    b0 = b.min()
    hist = np.bincount(b - b0, weights=sz)
    sm = np.convolve(np.pad(hist, 1, mode="edge"), [0.25, 0.5, 0.25], "valid")
    out: list[float] = []
    for i in range(win, len(sm) - win):
        if sm[i] > sm[i - win:i + win + 1].min():
            continue
        left, right = sm[max(0, i - reach):i].max(), sm[i + 1:i + 1 + reach].max()
        if sm[i] <= ratio * min(left, right) and (not out or (b0 + i + 0.5) * bin_pts - out[-1] > win * bin_pts):
            out.append(float((b0 + i + 0.5) * bin_pts))
    return out


def load_day(path: Path) -> Day | None:
    df = pd.read_parquet(path)
    if "action" in df:
        df = df[df["action"] == "T"]
    if df.empty:
        return None
    ts = (df["ts_event"] if "ts_event" in df else df.index.to_series()).astype("int64").to_numpy()
    order = np.argsort(ts, kind="stable")
    ts = ts[order]
    px = df["price"].to_numpy(float)[order]
    sz = df["size"].to_numpy(float)[order]
    side = np.select([df["side"].to_numpy() == "B", df["side"].to_numpy() == "A"], [1, -1], 0)[order].astype(np.int8)
    date = path.name[:10]
    return build_day(date, int(df["instrument_id"].mode().iloc[0]), ts, px, sz, side)


def build_day(date: str, instrument: int, ts, px, sz, side) -> Day:
    open_ns = pd.Timestamp(f"{date} 09:30", tz=ET).value
    close_ns = open_ns + 390 * MIN_NS
    keep = ts < close_ns
    ts, px, sz, side = ts[keep], px[keep], sz[keep], side[keep]
    rth0 = int(np.searchsorted(ts, open_ns))

    vwap = np.full(len(ts), np.nan)
    sd = np.full(len(ts), np.nan)
    v = np.cumsum(sz[rth0:])
    m1 = np.cumsum(px[rth0:] * sz[rth0:]) / v
    m2 = np.cumsum(px[rth0:] ** 2 * sz[rth0:]) / v
    vwap[rth0:] = m1
    sd[rth0:] = np.sqrt(np.maximum(m2 - m1 ** 2, 0.0))

    bounds = np.searchsorted(ts, open_ns + np.arange(391) * MIN_NS)
    last = bounds[1:] - 1
    close = np.where(bounds[1:] > bounds[:-1], px[np.maximum(last, 0)], np.nan)
    close = pd.Series(close).ffill().to_numpy()
    cd = np.r_[0.0, np.cumsum(side * sz)]
    delta = cd[bounds[1:]] - cd[bounds[:-1]]
    o = aggregate_orders(ts, px, sz, side)
    return Day(date, instrument, open_ns, ts, px, sz, side, rth0, vwap, sd, bounds, close, delta, *o)


def session_summary(day: Day) -> Session:
    px, sz = day.px[day.rth0:], day.sz[day.rth0:]
    return Session(day.instrument, float(px.max()), float(px.min()), low_volume_nodes(px, sz))


def static_levels(prev: Session | None, day: Day) -> list[tuple[str, float]]:
    if prev is None or prev.instrument != day.instrument:  # first day or contract roll
        return []
    return [("pdh", prev.high), ("pdl", prev.low)] + [("lvn", x) for x in prev.lvns]


def dynamic_levels(day: Day, i: int, p: Params, with_vwap: bool) -> list[tuple[str, float]]:
    """VWAP-band levels known after print i."""
    if i < day.rth0 or np.isnan(day.vwap[i]):
        return []
    out = [("vwap", day.vwap[i])] if with_vwap else []
    if day.ts[i] >= day.open_ns + p.band_after_min * MIN_NS and day.sd[i] > 0:
        out += [(f"vwap{k:+d}sd", day.vwap[i] + k * day.sd[i]) for k in (-2, -1, 1, 2)]
    return out


def price_before(day: Day, t: int) -> float:
    i = int(np.searchsorted(day.ts, t, side="right")) - 1
    return float(day.px[max(i, 0)])


def simulate(day: Day, direction: int, entry_i: int, stop: float, p: Params,
             levels: list[tuple[str, float]], trig: dict) -> dict | None:
    """Enter at print entry_i, pick the target, and walk prints to stop/target/flatten."""
    flat_i = int(np.searchsorted(day.ts, day.open_ns + p.flatten_min * MIN_NS))
    if entry_i >= flat_i - 1:
        return None
    entry = day.px[entry_i] + direction * SLIP
    risk = direction * (entry - stop)
    if risk > p.max_stop:
        return None
    if risk < p.min_stop:
        stop, risk = entry - direction * p.min_stop, p.min_stop

    lv = levels + dynamic_levels(day, entry_i - 1, p, with_vwap=True)
    ahead = [(k, x) for k, x in lv if direction * (x - entry) >= TICK]
    if ahead:
        tkind, target = min(ahead, key=lambda kx: direction * (kx[1] - entry))
        if direction * (target - entry) < p.min_rr * risk:
            return None
    else:
        tkind, target = f"{p.fallback_rr:g}R", entry + direction * p.fallback_rr * risk

    path = day.px[entry_i + 1:flat_i]
    hit_stop = direction * (path - stop) <= 0
    hit_tgt = direction * (path - target) >= TICK
    si = int(hit_stop.argmax()) if hit_stop.any() else len(path)
    ti = int(hit_tgt.argmax()) if hit_tgt.any() else len(path)
    if si < ti:
        j, reason = si, "stop"
        exit_px = (min(stop, path[j]) if direction > 0 else max(stop, path[j])) - direction * SLIP
    elif ti < len(path):
        j, reason, exit_px = ti, "target", target
    else:
        j, reason, exit_px = len(path) - 1, "eod", path[-1] - direction * SLIP
    exit_i = entry_i + 1 + j
    pnl = direction * (exit_px - entry) - COMMISSION_PTS
    # Excursions while open (points from the entry fill), for prop-account drawdown replay.
    held = direction * (day.px[entry_i:exit_i + 1] - entry)
    mae, mfe = min(float(held.min()), direction * (exit_px - entry)), max(float(held.max()), 0.0)
    return dict(
        date=day.date, cell=p.name, direction=direction, **trig,
        entry_time=pd.Timestamp(day.ts[entry_i], tz="UTC").tz_convert(ET).strftime("%H:%M:%S"),
        entry=entry, stop=stop, target=target, target_kind=tkind, risk=risk,
        exit=exit_px, exit_reason=reason, exit_ns=int(day.ts[exit_i]),
        bars_held=int((day.ts[exit_i] - day.ts[entry_i]) // MIN_NS), pnl_pts=pnl, r=pnl / risk,
        mae_pts=mae, mfe_pts=mfe,
    )


def candidates(day: Day, statics: list[tuple[str, float]], p: Params):
    """Yield (order index, direction, level kind, level price) in time order."""
    t = day.ts[day.o_start]
    live = (t >= day.open_ns) & (t < day.open_ns + p.last_entry_min * MIN_NS)
    if p.trigger in ("absorb", "with_flow"):
        live &= (day.o_size >= p.bubble_size) & (day.o_side != 0)
    js = np.flatnonzero(live)
    # Vectorized prefilter (same levels as the exact check below): orders near any level.
    prev_i = day.o_start[js] - 1
    bands_ok = ((prev_i >= day.rth0) & (t[js] >= day.open_ns + p.band_after_min * MIN_NS)
                & (day.sd[np.maximum(prev_i, 0)] > 0))
    vw, sd = day.vwap[np.maximum(prev_i, 0)], day.sd[np.maximum(prev_i, 0)]
    lv = np.column_stack([np.full(len(js), x) for _, x in statics]
                         + [np.where(bands_ok, vw + k * sd, np.nan) for k in (-2, -1, 1, 2)])
    dist = np.maximum(np.maximum(day.o_lo[js, None] - lv, lv - day.o_hi[js, None]), 0.0)
    js = js[(dist <= p.level_tol).any(axis=1)]
    last_touch: dict[tuple[str, int], int] = {}
    for j in js:
        s = int(day.o_start[j])
        lv = statics + dynamic_levels(day, s - 1, p, with_vwap=False)
        if not lv:
            continue
        lo, hi = day.o_lo[j], day.o_hi[j]
        ap = price_before(day, int(t[j]) - p.approach_min * MIN_NS)
        best = None
        for kind, x in lv:
            dist = max(lo - x, x - hi, 0.0)
            if dist > p.level_tol:
                continue
            came_from = -1 if ap < x else 1 if ap > x else 0  # -1: from below -> short
            if came_from == 0:
                continue
            if p.trigger == "absorb":
                ok = day.o_side[j] == -came_from  # buyers into resistance / sellers into support
            elif p.trigger == "with_flow":
                ok = day.o_side[j] == came_from
            else:
                ok = True
            if ok and (best is None or dist < best[0]):
                best = (dist, came_from, kind, x)
        if best is None:
            continue
        _, direction, kind, x = best
        if p.trigger == "touch":  # one touch per level per minute, or it's every print
            key, minute = (kind, direction), int((t[j] - day.open_ns) // MIN_NS)
            if last_touch.get(key) == minute:
                continue
            last_touch[key] = minute
        yield j, direction, kind, x


def run_day(day: Day, statics: list[tuple[str, float]], p: Params) -> list[dict]:
    if p.trigger == "random":
        return run_random(day, statics, p)
    trades, busy_until = [], -1
    for j, direction, kind, x in candidates(day, statics, p):
        s = int(day.o_start[j])
        if day.ts[s] <= busy_until:
            continue
        trig_px = day.o_lo[j] if direction < 0 else day.o_hi[j]  # far edge of the bubble
        # Acceptance: a whole minute that starts after the bubble closes beyond it.
        m0 = int((day.ts[s] - day.open_ns) // MIN_NS) + 1
        for m in range(m0, min(m0 + p.confirm_min, p.last_entry_min)):
            if direction * (day.close[m] - trig_px) > 0 and (not p.footprint or direction * day.delta[m] > 0):
                break
        else:
            continue
        seg = day.px[s:day.bounds[m + 1]]
        stop = (seg.max() if direction < 0 else seg.min()) - direction * p.stop_buffer
        trig = dict(level_kind=kind, level=x, trigger_size=float(day.o_size[j]),
                    trigger_time=pd.Timestamp(day.ts[s], tz="UTC").tz_convert(ET).strftime("%H:%M:%S"))
        tr = simulate(day, direction, int(day.bounds[m + 1]), stop, p, statics, trig)
        if tr:
            trades.append(tr)
            busy_until = tr["exit_ns"]
    return trades


def run_random(day: Day, statics, p: Params) -> list[dict]:
    """Noise floor: ~3 random-minute entries a session, random side, a 6/10/15-pt stop,
    and the same target rule."""
    rng = np.random.default_rng([p.seed, int(day.date.replace("-", ""))])
    trades, busy_until = [], -1
    for m in np.sort(rng.choice(p.last_entry_min, size=rng.poisson(3), replace=False)):
        i = int(day.bounds[m + 1])
        if i >= len(day.ts) or day.ts[i] <= busy_until:
            continue
        direction = int(rng.choice([-1, 1]))
        stop = day.px[i] + direction * SLIP - direction * float(rng.choice([6.0, 10.0, 15.0]))
        tr = simulate(day, direction, i, stop, p, statics,
                      dict(level_kind="random", level=np.nan, trigger_size=0.0, trigger_time=""))
        if tr:
            trades.append(tr)
            busy_until = tr["exit_ns"]
    return trades


def grid() -> list[Params]:
    cells = []
    for b in (60, 100):
        for tol in (3.0, 6.0):
            for fp in (False, True):
                cells += [Params("absorb", b, tol, fp), Params("with_flow", b, tol, fp)]
    for tol in (3.0, 6.0):
        for fp in (False, True):
            cells.append(Params("touch", 0, tol, fp))
    return cells + [Params("random", seed=s) for s in range(20)]


def summarize(tr: pd.DataFrame, sessions: list[str], n_boot=2000, seed=0) -> dict:
    """Trade stats; the CI resamples whole sessions so intraday clustering is kept."""
    if tr.empty:
        return dict(n=0)
    r = tr["r"].to_numpy()
    by = tr.groupby("date")["r"].agg(["sum", "count"]).reindex(sessions, fill_value=0)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(by), size=(n_boot, len(by)))
    s, c = by["sum"].to_numpy()[idx].sum(1), by["count"].to_numpy()[idx].sum(1)
    boot = s[c > 0] / c[c > 0]
    eq = np.cumsum(r)
    wins, losses = r[r > 0].sum(), -r[r < 0].sum()
    return dict(
        n=len(r), per_session=round(len(r) / len(sessions), 2), win_rate=round(float((r > 0).mean()), 3),
        mean_r=round(float(r.mean()), 3), ci95=[round(float(q), 3) for q in np.percentile(boot, [2.5, 97.5])],
        total_r=round(float(r.sum()), 1), profit_factor=round(float(wins / losses), 2) if losses else None,
        max_dd_r=round(float((np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]).max()), 1),
        mean_pts=round(float(tr["pnl_pts"].mean()), 2), usd_per_nq=round(float(tr["pnl_pts"].sum() * POINT_VALUE)),
        median_risk_pts=round(float(tr["risk"].median()), 2),
        exits={k: int(v) for k, v in tr["exit_reason"].value_counts().items()},
    )


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=DATA)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    files = sorted(args.data.glob("*.parquet"))
    # Research data only: nothing from the verify block or the gap week before it.
    cutoff = (VERIFY_START - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    files = [f for f in files if f.name[:10] < cutoff]
    if not files:
        print(f"no data under {args.data}")
        return 1
    cells = grid()
    trades: list[dict] = []
    sessions: list[str] = []
    prev: Session | None = None
    for f in files:
        day = load_day(f)
        if day is None or day.rth0 >= len(day.ts):
            continue
        sessions.append(day.date)
        statics = static_levels(prev, day)
        for p in cells:
            trades += run_day(day, statics, p)
        prev = session_summary(day)
        print(f"{day.date}  prints={len(day.ts):>7}  levels={len(statics):>2}  "
              f"bubbles>=60={int((day.o_size >= 60).sum()):>4}  trades so far={len(trades)}")

    tr = pd.DataFrame(trades)
    cut = sessions[int(len(sessions) * DISCOVERY_FRAC)]
    disc_s, hold_s = [s for s in sessions if s < cut], [s for s in sessions if s >= cut]
    disc, hold = tr[tr["date"] < cut], tr[tr["date"] >= cut]

    table = {}
    for p in cells:
        table[p.name] = dict(discovery=summarize(disc[disc["cell"] == p.name], disc_s),
                             holdout=summarize(hold[hold["cell"] == p.name], hold_s))
    # Pick the strategy cell on discovery only (>= 30 trades), then read its holdout once.
    eligible = [p for p in cells if p.trigger == "absorb" and table[p.name]["discovery"].get("n", 0) >= 30]
    best = max(eligible, key=lambda p: table[p.name]["discovery"]["mean_r"]) if eligible else None
    controls = {}
    if best:
        controls = {
            "with_flow": replace(best, trigger="with_flow").name,
            "touch": replace(best, trigger="touch", bubble_size=0).name,
        }
    rnd = tr[tr["cell"].str.startswith("random")]
    random_floor = {
        split: summarize(rnd[(rnd["date"] < cut) == (split == "discovery")], ss)
        for split, ss in (("discovery", disc_s), ("holdout", hold_s))
    }

    args.out.mkdir(parents=True, exist_ok=True)
    tr.drop(columns=["exit_ns"]).to_csv(args.out / "trades.csv", index=False)
    report = dict(
        sessions=dict(all=len(sessions), discovery=[disc_s[0], disc_s[-1], len(disc_s)],
                      holdout=[hold_s[0], hold_s[-1], len(hold_s)]),
        costs=dict(commission_pts=COMMISSION_PTS, slippage_ticks=1),
        defaults=asdict(Params()), selected=best.name if best else None, controls=controls,
        random_floor=random_floor, cells={k: v for k, v in table.items() if not k.startswith("random")},
    )
    (args.out / "report.json").write_text(json.dumps(report, indent=2))

    print(f"\nsessions: discovery {disc_s[0]}..{disc_s[-1]} ({len(disc_s)}), "
          f"holdout {hold_s[0]}..{hold_s[-1]} ({len(hold_s)})")
    hdr = f"{'cell':<32}{'n':>5}{'win':>7}{'meanR':>8}{'CI95':>18}{'totR':>8}  |{'n':>5}{'win':>7}{'meanR':>8}{'CI95':>18}{'totR':>8}"
    print(hdr)
    for name, row in list(table.items()) + [("random (20 seeds pooled)", random_floor)]:
        if name.startswith("random/"):
            continue
        cols = []
        for split in ("discovery", "holdout"):
            s = row[split]
            cols.append(f"{s.get('n', 0):>5}{s.get('win_rate', 0):>7.2f}{s.get('mean_r', 0):>8.3f}"
                        f"{str(s.get('ci95', '')):>18}{s.get('total_r', 0):>8.1f}")
        print(f"{name:<32}{cols[0]}  |{cols[1]}")
    print(f"\nselected on discovery: {report['selected']}   controls: {controls}")
    print(f"wrote {args.out / 'report.json'} and trades.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
