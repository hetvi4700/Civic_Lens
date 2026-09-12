function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatHours(hours) {
  const value = num(hours);
  if (value <= 0) return '0m';
  if (value < 1) return `${Math.round(value * 60)}m`;
  if (value < 24) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
}

/** SHAP contribution in the same hour-scale units as the waterfall chart. */
export function formatShapContribution(hours) {
  const value = num(hours);
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs < 1) {
    const minutes = Math.round(abs * 60);
    return minutes === 0 ? `${sign}0m` : `${sign}${minutes}m`;
  }
  return `${sign}${abs.toFixed(1)}h`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
