import { formatHours } from './analytics';

const NYC_LABEL = 'New York City';

function isActive(value) {
  return value != null && value !== '' && value !== 'All';
}

function buildAreaInsight({
  areaName,
  isCitywide,
  avgResponseHours,
  unresolvedRate,
  topVolumeComplaint,
  highestBurdenBorough,
  highestBurdenScore,
}) {
  if (!areaName || areaName === '—') {
    return 'Select a borough on the map to see area-specific insights.';
  }

  const unresolvedPct = (unresolvedRate * 100).toFixed(1);
  let text = `${areaName} averages ${formatHours(avgResponseHours)} response time with a ${unresolvedPct}% unresolved rate across all complaint types.`;

  if (topVolumeComplaint?.complaintType) {
    const categoryUnresolvedPct = ((topVolumeComplaint.unresolvedRate ?? 0) * 100).toFixed(1);
    text += ` Its highest-volume category is ${topVolumeComplaint.complaintType} (${topVolumeComplaint.count.toLocaleString()} requests, ${formatHours(topVolumeComplaint.avgResponseHours)} avg, ${categoryUnresolvedPct}% unresolved).`;
  }

  if (isCitywide && highestBurdenBorough && highestBurdenScore != null) {
    text += ` ${highestBurdenBorough} has the highest burden score (${Number(highestBurdenScore).toFixed(2)}).`;
  }

  return text;
}

export function buildAreaSummary(filters, boroughStats, complaintStats, stats) {
  if (!boroughStats?.length && !stats) {
    return {
      areaName: '—',
      isDefault: true,
      isCitywide: true,
      totalRequests: 0,
      avgResponseHours: 0,
      unresolvedRate: 0,
      highDelayCount: 0,
      topComplaintType: '—',
      topAgency: '—',
      insight: 'No requests match the current filters.',
    };
  }

  const selectedBorough = isActive(filters.borough) ? filters.borough : null;
  const isCitywide = !selectedBorough;
  const topVolumeComplaint = complaintStats?.[0] ?? null;
  const highestBurdenBorough = boroughStats?.[0] ?? null;

  if (isCitywide) {
    return {
      areaName: NYC_LABEL,
      isDefault: true,
      isCitywide: true,
      totalRequests: stats?.totalRequests ?? 0,
      avgResponseHours: stats?.avgResponseHours ?? 0,
      unresolvedRate: stats?.unresolvedRate ?? 0,
      highDelayCount: stats?.highDelayCount ?? 0,
      topComplaintType: topVolumeComplaint?.complaintType ?? '—',
      topAgency: '—',
      highestBurdenBorough: highestBurdenBorough?.borough ?? null,
      highestBurdenScore: highestBurdenBorough?.burdenScore ?? null,
      insight: buildAreaInsight({
        areaName: NYC_LABEL,
        isCitywide: true,
        avgResponseHours: stats?.avgResponseHours ?? 0,
        unresolvedRate: stats?.unresolvedRate ?? 0,
        topVolumeComplaint,
        highestBurdenBorough: highestBurdenBorough?.borough ?? null,
        highestBurdenScore: highestBurdenBorough?.burdenScore ?? null,
      }),
    };
  }

  const boroughEntry = boroughStats.find((entry) => entry.borough === selectedBorough)
    ?? boroughStats[0];

  return {
    areaName: selectedBorough,
    isDefault: false,
    isCitywide: false,
    totalRequests: stats?.totalRequests ?? boroughEntry?.count ?? 0,
    avgResponseHours: stats?.avgResponseHours ?? boroughEntry?.avgResponseHours ?? 0,
    unresolvedRate: stats?.unresolvedRate ?? boroughEntry?.unresolvedRate ?? 0,
    highDelayCount: stats?.highDelayCount ?? boroughEntry?.highDelayCount ?? 0,
    topComplaintType: topVolumeComplaint?.complaintType ?? '—',
    topAgency: '—',
    insight: buildAreaInsight({
      areaName: selectedBorough,
      isCitywide: false,
      avgResponseHours: stats?.avgResponseHours ?? boroughEntry?.avgResponseHours ?? 0,
      unresolvedRate: stats?.unresolvedRate ?? boroughEntry?.unresolvedRate ?? 0,
      topVolumeComplaint,
    }),
  };
}

export function buildDelayDrivers(complaintStats, showcaseYear = null) {
  if (!complaintStats?.length) return [];

  const yearLabel = showcaseYear ? ` in ${showcaseYear}` : '';
  const drivers = [];
  const slowestComplaint = [...complaintStats].sort(
    (a, b) => b.avgResponseHours - a.avgResponseHours,
  )[0];
  if (slowestComplaint) {
    drivers.push({
      key: 'complaint_delay',
      label: 'Slowest complaint type',
      value: slowestComplaint.complaintType,
      detail: `${formatHours(slowestComplaint.avgResponseHours)} avg · ${slowestComplaint.count.toLocaleString()} requests${yearLabel}`,
      score: slowestComplaint.avgResponseHours,
    });
  }

  const unresolvedHeavy = [...complaintStats].sort(
    (a, b) => b.unresolvedRate - a.unresolvedRate,
  )[0];
  if (unresolvedHeavy && unresolvedHeavy.unresolvedRate > 0) {
    drivers.push({
      key: 'unresolved',
      label: 'Unresolved-heavy category',
      value: unresolvedHeavy.complaintType,
      detail: `${(unresolvedHeavy.unresolvedRate * 100).toFixed(1)}% unresolved`,
      score: unresolvedHeavy.unresolvedRate,
    });
  }

  const highestVolume = complaintStats[0];
  if (highestVolume) {
    drivers.push({
      key: 'volume',
      label: 'Highest-volume category',
      value: highestVolume.complaintType,
      detail: `${highestVolume.count.toLocaleString()} requests${yearLabel}`,
      score: highestVolume.count,
    });
  }

  return drivers
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
