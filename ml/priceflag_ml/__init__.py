"""Priceflag Lane C — ML package.

Modules:
- golden:    synthetic golden-data generator with known ground truth
- data:      read-only data access (Supabase PostgREST or golden fixture)
- baselines: incumbent models (seasonal-naive forecaster, bracket elasticity)
- metrics:   scoring functions (coverage, pinball, MAPE/WAPE, recovery error)
- harness:   rolling-origin backtests + golden-recovery evaluation
"""

__version__ = "0.1.0"
