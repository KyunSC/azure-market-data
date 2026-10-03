from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ML_DIR / 'data' / 'flybrain'
RUNS_DIR = Path(__file__).parent / 'runs'
SYMBOLS = {'QQQ': 'MNQ', 'SPY': 'MES'}
RATIO = {'QQQ': 41.2, 'SPY': 10.05}
CONTRACTS = {k: dict(point_value=v, tick=0.25) for k, v in [('MNQ', 2), ('MES', 5), ('NQ', 20), ('ES', 50)]}
N_CONTRACTS = 2
COMMISSION_PER_SIDE = 0.50
SLIPPAGE_TICKS = 1
PROP = dict(firm='lucid', plan='flex', size='50k', dll=True, paths=1000, block=5, horizon=250, seed=42)
EVAL_FEE = 0.0
DISCOVERY_FRAC = 0.70
WF_SPLITS = 4
EMBARGO_SESSIONS = 1
TRIALS_PER_NIGHT = 100
MAX_TRIALS_LIFETIME = 2000
GATES = dict(min_trades=30, min_pos_folds=3, dsr_min=0.95, min_holdout_trades=10, family_alpha=0.05)
LOOKAHEAD_PROBES = 40
WARMUP_SESSIONS = 20
BARS_PER_SESSION = 78
PPY = BARS_PER_SESSION * 252
DAN_DECAY = 1e-4
CONTROL_SEEDS = 50
BOOTSTRAP_SAMPLES = 2000
TOP_K = 5
SEARCH_SPACE = dict(rho=[0.5, 0.8, 0.95, 1.1], leak=[0.1, 0.3, 0.6, 1.0], input_gain=[0.5, 1.0, 2.0],
    kc_sparsity=[None, 0.05, 0.10], readout_from=['kc', 'mbon'], readout=['ridge', 'dan'],
    ridge_lambda=[1.0, 10.0, 100.0], dan_lr=[1e-3, 1e-2], horizon_bars=[1, 3, 6, 12],
    threshold_q=[0.60, 0.75, 0.90], gex_off=[False, True], hemisphere=['right'])
CIRCUITS = ['fly', 'shuffle', 'random', 'none']
