"""Make `priceflag_ml` importable regardless of where pytest is invoked from.

Allows both `pytest ml/` from the repo root and `pytest` from inside `ml/`
without installing the package.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
