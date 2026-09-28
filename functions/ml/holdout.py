"""Sealed verify set: research data | one-week gap | verify data.

    [ research (walk-forward, tuning, SHAP) ][ gap ][ verify (final_verify.py only) ]

The verify block starts at a pinned date, not "the last N sessions", so it stays
the same data as new sessions are ingested — anything after VERIFY_START simply
extends it. The GAP_SESSIONS sessions before it belong to neither side, so no
research-side target, rolling feature or intra-week regime bleeds into verify.

Every script that fits or inspects a model loads data through `load_research`.
Only `final_verify.py` touches `verify`.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from eval import session_ids

VERIFY_START = pd.Timestamp("2026-08-24", tz="America/New_York")  # a Monday
GAP_SESSIONS = 5  # one trading week


def split_holdout(
    df: pd.DataFrame,
    verify_start: pd.Timestamp = VERIFY_START,
    gap_sessions: int = GAP_SESSIONS,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Return (research, verify). Both are reset-index copies in date order."""
    date = pd.to_datetime(df["date"], utc=True)
    sid = session_ids(date)
    in_verify = (date >= verify_start).to_numpy()
    if not in_verify.any():
        return df.reset_index(drop=True), df.iloc[:0].copy()

    first_verify_sid = int(sid[in_verify].min())
    research_mask = sid < first_verify_sid - gap_sessions
    research = df[research_mask].reset_index(drop=True)
    verify = df[in_verify].reset_index(drop=True)

    if "target_time" in df and len(research):
        assert pd.to_datetime(research["target_time"], utc=True).max() < date[in_verify].min(), \
            "LEAK: research target reaches verify"
    return research, verify


def load_research(path: Path) -> pd.DataFrame:
    return split_holdout(pd.read_parquet(path))[0]


def describe(df: pd.DataFrame) -> str:
    if df.empty:
        return "0 rows"
    d = pd.to_datetime(df["date"], utc=True).dt.tz_convert("America/New_York")
    return f"{len(df)} rows, {np.unique(d.dt.date).size} sessions, {d.min().date()} -> {d.max().date()}"
