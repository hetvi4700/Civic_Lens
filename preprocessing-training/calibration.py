"""Inference-time calibration helpers for Civic Lens delay predictions."""

import numpy as np

BUCKET_ORDER = ["Same Day", "1-3 Days", "3-7 Days", "7+ Days"]


def bucket(x):
    if x <= 24:
        return "Same Day"
    if x <= 72:
        return "1-3 Days"
    if x <= 168:
        return "3-7 Days"
    return "7+ Days"


def apply_calibration(pred, cal):
    """Apply band-specific scales (mutually exclusive — no double-multiply)."""
    version = cal.get("version", "")

    if version not in ("piecewise_v1", "piecewise_v2"):
        # Legacy blanket fallback
        out = pred.copy()
        if cal.get("scale_above_72h", 1.0) != 1.0:
            out[out > 72] *= cal["scale_above_72h"]
        if cal.get("scale_above_168h", 1.0) != 1.0:
            out[out > 168] *= cal["scale_above_168h"]
        return np.maximum(out, 0)

    out = pred.copy()
    out[(out > 72) & (out <= 120)] *= cal.get("scale_72_120", 1.0)

    if version == "piecewise_v2":
        out[(out > 120) & (out <= 145)] *= cal.get("scale_120_145", 1.0)
        out[(out > 145) & (out <= 168)] *= cal.get("scale_145_168", 1.0)
    else:
        out[(out > 120) & (out <= 168)] *= cal.get("scale_120_168", 1.0)

    out[out > 168] *= cal.get("scale_above_168", 1.0)
    return np.maximum(out, 0)
