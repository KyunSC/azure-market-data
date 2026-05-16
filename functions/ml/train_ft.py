"""Train FT-Transformer, two variants (with vs without GEX features), via walk-forward CV.

Outputs:
  - Console: per-fold IC + overall summary for each variant + delta
  - functions/ml/data/ft_oos_predictions.parquet (OOS preds for both, for plotting)

Run: python functions/ml/train_ft.py
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

# Let MPS silently CPU-fall-back on any unsupported op (small perf hit, big robustness win).
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

from rtdl_revisiting_models import FTTransformer  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import (  # noqa: E402
    walk_forward, summarize,
    FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX, TARGET,
)

DATA_PATH = Path(__file__).resolve().parent / "data" / "qqq_5m_features_h3.parquet"
OOS_OUT  = Path(__file__).resolve().parent / "data" / "ft_oos_predictions.parquet"

SEED = 42


def get_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class FTTRegressor:
    """sklearn-compatible wrapper around FT-Transformer for the walk-forward harness.

    Heavy regularization aimed at the small-data regime (n~600 train rows/fold):
      - n_blocks=2, d_block=96 (smaller than paper default of d_block=128 at n_blocks=3)
      - attention_dropout=0.2, ffn_dropout=0.1 (above paper defaults)
      - AdamW with weight_decay=1e-5
      - Early stopping on a held-out last-15% slice of the training fold
      - Per-fold X and y standardization (fit on train portion only — no leakage)
    """

    def __init__(
        self,
        n_features: int,
        n_blocks: int = 2,
        d_block: int = 96,
        attention_n_heads: int = 8,
        attention_dropout: float = 0.2,
        ffn_dropout: float = 0.1,
        lr: float = 1e-4,
        weight_decay: float = 1e-5,
        batch_size: int = 64,
        max_epochs: int = 200,
        patience: int = 20,
        val_frac: float = 0.15,
        device: torch.device | None = None,
        random_state: int = SEED,
    ):
        self.n_features = n_features
        self.n_blocks = n_blocks
        self.d_block = d_block
        self.attention_n_heads = attention_n_heads
        self.attention_dropout = attention_dropout
        self.ffn_dropout = ffn_dropout
        self.lr = lr
        self.weight_decay = weight_decay
        self.batch_size = batch_size
        self.max_epochs = max_epochs
        self.patience = patience
        self.val_frac = val_frac
        self.device = device or get_device()
        self.random_state = random_state
        self.model: nn.Module | None = None
        self.x_mean = self.x_std = self.y_mean = self.y_std = None

    def _build_model(self) -> nn.Module:
        torch.manual_seed(self.random_state)
        defaults = FTTransformer.get_default_kwargs(n_blocks=self.n_blocks)
        defaults["d_block"] = self.d_block
        defaults["attention_n_heads"] = self.attention_n_heads
        defaults["attention_dropout"] = self.attention_dropout
        defaults["ffn_dropout"] = self.ffn_dropout
        defaults["_is_default"] = False
        return FTTransformer(
            n_cont_features=self.n_features,
            cat_cardinalities=[],
            d_out=1,
            **defaults,
        ).to(self.device)

    def fit(self, X: np.ndarray, y: np.ndarray):
        n = len(X)
        n_val = max(1, int(n * self.val_frac))
        X_tr, X_val = X[:-n_val], X[-n_val:]
        y_tr, y_val = y[:-n_val], y[-n_val:]

        self.x_mean = X_tr.mean(axis=0)
        self.x_std = X_tr.std(axis=0) + 1e-8
        self.y_mean = float(y_tr.mean())
        self.y_std = float(y_tr.std() + 1e-8)

        X_tr_s = (X_tr - self.x_mean) / self.x_std
        X_val_s = (X_val - self.x_mean) / self.x_std
        y_tr_s = (y_tr - self.y_mean) / self.y_std
        y_val_s = (y_val - self.y_mean) / self.y_std

        Xt = torch.tensor(X_tr_s, dtype=torch.float32, device=self.device)
        yt = torch.tensor(y_tr_s, dtype=torch.float32, device=self.device).unsqueeze(-1)
        Xv = torch.tensor(X_val_s, dtype=torch.float32, device=self.device)
        yv = torch.tensor(y_val_s, dtype=torch.float32, device=self.device).unsqueeze(-1)

        gen = torch.Generator().manual_seed(self.random_state)
        loader = DataLoader(TensorDataset(Xt, yt), batch_size=self.batch_size, shuffle=True, generator=gen)

        self.model = self._build_model()
        optim = torch.optim.AdamW(self.model.parameters(), lr=self.lr, weight_decay=self.weight_decay)
        loss_fn = nn.MSELoss()

        best_val = float("inf")
        best_state = None
        epochs_no_improve = 0

        for epoch in range(self.max_epochs):
            self.model.train()
            for xb, yb in loader:
                optim.zero_grad()
                pred = self.model(xb, None)
                loss = loss_fn(pred, yb)
                loss.backward()
                optim.step()

            self.model.eval()
            with torch.no_grad():
                val_loss = loss_fn(self.model(Xv, None), yv).item()

            if val_loss < best_val - 1e-6:
                best_val = val_loss
                best_state = {k: v.detach().clone() for k, v in self.model.state_dict().items()}
                epochs_no_improve = 0
            else:
                epochs_no_improve += 1
                if epochs_no_improve >= self.patience:
                    break

        if best_state is not None:
            self.model.load_state_dict(best_state)
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        X_s = (X - self.x_mean) / self.x_std
        Xt = torch.tensor(X_s, dtype=torch.float32, device=self.device)
        self.model.eval()
        with torch.no_grad():
            pred_s = self.model(Xt, None).squeeze(-1).cpu().numpy()
        return pred_s * self.y_std + self.y_mean


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    device = get_device()
    logging.info("Device: %s", device)

    df = pd.read_parquet(DATA_PATH)
    logging.info("Loaded %d rows", len(df))

    print("\n[1/2] FT-T-base — %d features" % len(FEATURES_BASELINE))
    res_base = walk_forward(
        df, features=FEATURES_BASELINE,
        model_factory=lambda: FTTRegressor(n_features=len(FEATURES_BASELINE), device=device),
    )
    summarize("FT-T-base", res_base)

    print("\n[2/2] FT-T-GEX — %d features" % len(FEATURES_BASELINE_PLUS_GEX))
    res_gex = walk_forward(
        df, features=FEATURES_BASELINE_PLUS_GEX,
        model_factory=lambda: FTTRegressor(n_features=len(FEATURES_BASELINE_PLUS_GEX), device=device),
    )
    summarize("FT-T-GEX", res_gex)

    print("\n=== Delta (FT-T-GEX minus FT-T-base) ===")
    bm, gm = res_base.overall_metrics, res_gex.overall_metrics
    print(f"  d(IC Pearson)        = {gm['ic_pearson']  - bm['ic_pearson']:+.4f}")
    print(f"  d(IC Spearman)       = {gm['ic_spearman'] - bm['ic_spearman']:+.4f}")
    print(f"  d(Directional acc)   = {gm['directional_acc'] - bm['directional_acc']:+.4f}")
    print(f"  d(Sharpe annualized) = {gm['strategy_sharpe_ann'] - bm['strategy_sharpe_ann']:+.2f}")

    oos = pd.DataFrame({
        "oos_idx":     res_base.oos_idx,
        "date":        df["date"].iloc[res_base.oos_idx].values,
        "y_true":      res_base.oos_true,
        "ft_base_pred": res_base.oos_pred,
        "ft_gex_pred":  res_gex.oos_pred,
    })
    OOS_OUT.parent.mkdir(parents=True, exist_ok=True)
    oos.to_parquet(OOS_OUT, index=False)
    print(f"\nSaved OOS predictions: {OOS_OUT}")


if __name__ == "__main__":
    sys.exit(main())
