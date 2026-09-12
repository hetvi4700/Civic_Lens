import { Box, Stack, Typography, Chip, alpha } from '@mui/material';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import { useAppColors } from '../ColorModeContext';
import { getPredictionSummary, buildShapContributionsInHours } from '../utils/mlExplanation';
import { formatHours, formatShapContribution } from '../utils/analytics';
import { MODEL_ROW_HEIGHT, cardSubtitleSx, cardTitleSx, smallMetaSx } from '../styles/modelViewLayout';
import DashboardCard from './DashboardCard';

// Match the SHAP chart palette: pink = increases delay, violet = reduces delay
const DRIVER_UP = '#EC4899';
const DRIVER_DOWN = '#8B5CF6';

const DRIVER_LABELS = {
  agency_complaint_median: 'Complaint history',
  agency_zip_median: 'ZIP history',
  agency_workload_24h: 'Agency workload',
  complaint_type: 'Complaint type',
  month: 'Seasonality',
  borough: 'Borough',
  agency: 'Agency',
  open_data_channel_type: 'Channel',
};

function riskColor(level, colors) {
  switch (level) {
    case 'Critical':
    case 'High':
      return colors.error;
    case 'Medium':
      return colors.warning;
    default:
      return colors.secondary;
  }
}

function riskLabel(level) {
  if (!level) return '—';
  return String(level).toLowerCase().includes('risk') ? level : `${level} Risk`;
}

function driverLabel(row) {
  return row?.label || DRIVER_LABELS[row?.feature] || row?.feature || 'Factor';
}

const cardShellSx = {
  p: '22px',
  height: MODEL_ROW_HEIGHT,
  width: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  '&:last-child': { pb: '22px' },
};

export default function PredictionOverviewCard({ request, onViewRecord }) {
  const colors = useAppColors();

  if (!request) {
    return (
      <DashboardCard sx={{ width: '100%' }} contentSx={{ ...cardShellSx, justifyContent: 'center' }}>
        <Typography variant="subtitle2" sx={{ ...cardTitleSx, color: colors.textSecondary, mb: 1 }}>
          Prediction
        </Typography>
        <Typography variant="body2" sx={{ ...cardSubtitleSx, color: colors.textSecondary }}>
          No case selected.
        </Typography>
      </DashboardCard>
    );
  }

  const summary = getPredictionSummary(request);
  const riskAccent = riskColor(summary.riskLevel, colors);
  const predictedLabel = `${Math.round(summary.predictedHours)} hours`;
  const elapsedLabel = formatHours(summary.actualHours);
  const agency = request.agency || request.agency_name || '—';
  const location = [request.borough, request.incident_zip].filter(Boolean).join(' ');
  const context = [request.complaint_type, agency, location].filter(Boolean).join(' · ');

  // Delay risk score (0–1) — try the common field paths, clamp to [0,1]
  const rawRisk = summary.riskScore ?? request.delay_risk_score ?? request.shap_explanation?.risk_score;
  const riskScore = Number(rawRisk);
  const hasRisk = Number.isFinite(riskScore) && riskScore > 0;
  const riskPct = Math.max(0, Math.min(1, riskScore)) * 100;

  // Top 3 drivers by absolute SHAP contribution
  const drivers = buildShapContributionsInHours(request, { limit: 3 });

  return (
    <DashboardCard sx={{ width: '100%' }} contentSx={cardShellSx}>
      <Typography variant="subtitle2" sx={{ ...cardTitleSx, color: colors.textSecondary, mb: 1 }}>
        Prediction
      </Typography>

      {/* Headline prediction + bucket / risk chips */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography
            component="p"
            sx={{ fontWeight: 800, letterSpacing: '-0.03em', color: colors.textPrimary, lineHeight: 1, fontSize: '2.15rem' }}
          >
            {predictedLabel}
          </Typography>
          <Typography sx={{ ...smallMetaSx, color: colors.textSecondary, mt: 0.5 }}>
            predicted response time
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', pb: 0.25 }}>
          <Chip
            size="small"
            label={summary.delayBucket}
            sx={{
              height: 22, fontWeight: 700, ...smallMetaSx,
              bgcolor: alpha(colors.primary, 0.1), color: colors.primary,
              border: `1px solid ${alpha(colors.primary, 0.28)}`,
            }}
          />
          <Chip
            size="small"
            label={riskLabel(summary.riskLevel)}
            sx={{
              height: 22, fontWeight: 700, ...smallMetaSx,
              bgcolor: alpha(riskAccent, 0.14), color: riskAccent,
              border: `1px solid ${alpha(riskAccent, 0.35)}`,
            }}
          />
        </Stack>
      </Stack>

      {/* Context line */}
      <Typography
        variant="body2"
        noWrap
        title={context}
        sx={{ ...cardSubtitleSx, color: colors.textPrimary, fontWeight: 600, mt: 1 }}
      >
        {context}
      </Typography>

      {/* Elapsed time + status */}
      <Stack
        direction="row"
        spacing={2}
        useFlexGap
        sx={{ flexWrap: 'wrap', mt: 1.25, pt: 1, borderTop: `1px solid ${colors.border}` }}
      >
        <Typography variant="body2" sx={{ ...cardSubtitleSx, color: colors.textSecondary }}>
          <Box component="span" sx={{ fontWeight: 700, color: colors.textSecondary }}>Elapsed: </Box>
          {elapsedLabel}
        </Typography>
        <Typography variant="body2" sx={{ ...cardSubtitleSx, color: colors.textSecondary }}>
          <Box component="span" sx={{ fontWeight: 700, color: colors.textSecondary }}>Status: </Box>
          {request.status ?? '—'}
        </Typography>
      </Stack>

      {/* Delay risk score meter */}
      <Box sx={{ mt: 1.5 }}>
        <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', mb: 0.6 }}>
          <Typography sx={{ ...smallMetaSx, color: colors.textSecondary, letterSpacing: '0.04em' }}>
            Delay risk score
          </Typography>
          <Typography sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: riskAccent, fontSize: '0.95rem', lineHeight: 1 }}>
            {hasRisk ? riskScore.toFixed(2) : '—'}
          </Typography>
        </Stack>
        <Box sx={{ position: 'relative', height: 8, borderRadius: 4, bgcolor: alpha(colors.textSecondary, 0.16), overflow: 'hidden' }}>
          <Box
            sx={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${hasRisk ? riskPct : 0}%`,
              borderRadius: 4, bgcolor: riskAccent,
              transition: 'width 0.4s ease',
            }}
          />
        </Box>
      </Box>

      {/* Top drivers */}
      {drivers.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography sx={{ ...smallMetaSx, color: colors.textSecondary, letterSpacing: '0.04em', mb: 0.5 }}>
            Top drivers
          </Typography>
          <Stack spacing={0.4}>
            {drivers.map((d, i) => {
              const up = d.shap >= 0;
              const tone = up ? DRIVER_UP : DRIVER_DOWN;
              const Arrow = up ? ArrowUpwardRoundedIcon : ArrowDownwardRoundedIcon;
              return (
                <Stack key={d.feature ?? i} direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}>
                    <Arrow sx={{ fontSize: 15, color: tone, flexShrink: 0 }} />
                    <Typography variant="body2" noWrap sx={{ color: colors.textPrimary, fontWeight: 600, fontSize: '0.82rem' }}>
                      {driverLabel(d)}
                    </Typography>
                  </Stack>
                  <Typography
                    variant="body2"
                    sx={{ color: tone, fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: '0.82rem', flexShrink: 0, ml: 1 }}
                  >
                    {formatShapContribution(d.shap)}
                  </Typography>
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}

      {/* View full record */}
      {onViewRecord && (
        <Typography
          component="button"
          type="button"
          onClick={onViewRecord}
          sx={{
            mt: 'auto', alignSelf: 'flex-start', border: 'none', background: 'none', cursor: 'pointer',
            ...cardSubtitleSx, color: colors.primary, fontWeight: 600, p: 0, pt: 1.25,
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          View full record →
        </Typography>
      )}
    </DashboardCard>
  );
}