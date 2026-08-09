import { Box, Typography, alpha, Divider } from '@mui/material';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import { useAppColors, useColorMode } from '../ColorModeContext';
import { formatHours } from '../utils/analytics';
import AppCard, { AppCardIconPill } from './AppCard';
import {
  getBoroughColor,
  getDashboardSemanticColors,
  getDriverValueColor,
  normalizeBoroughName,
} from '../styles/dashboardColors';

const MAX_DRIVERS = 3;

function MetricRow({ label, value, valueColor, colors, semantic }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
      <Typography sx={{ color: semantic.muted, fontSize: '0.75rem' }}>
        {label}
      </Typography>
      <Typography
        sx={{
          fontWeight: 700,
          color: valueColor ?? semantic.text,
          fontSize: '0.8125rem',
          textAlign: 'right',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

export default function SelectedAreaInsightPanel({ summary, drivers = [] }) {
  const colors = useAppColors();
  const { mode } = useColorMode();
  const semantic = getDashboardSemanticColors(colors, mode);

  const {
    areaName = '—',
    isCitywide = true,
    totalRequests = 0,
    avgResponseHours = 0,
    unresolvedRate = 0,
    highDelayCount = 0,
    insight = '',
  } = summary ?? {};

  const headerColor = isCitywide
    ? semantic.title
    : getBoroughColor(normalizeBoroughName(areaName), mode);
  const topDrivers = drivers.slice(0, MAX_DRIVERS);

  return (
    <AppCard
      accent="dashboard"
      compact
      contentSx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        height: '100%',
        flex: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <AppCardIconPill icon={InsightsOutlinedIcon} accentColor={semantic.burden} colors={colors} size="sm" />
        <Typography
          sx={{
            fontWeight: 700,
            fontSize: '0.9375rem',
            letterSpacing: '-0.01em',
            color: semantic.title,
          }}
        >
          Why this area stands out
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <PlaceOutlinedIcon sx={{ fontSize: 16, color: headerColor, flexShrink: 0 }} />
        <Typography
          sx={{
            fontWeight: 800,
            fontSize: '1.05rem',
            color: headerColor,
            letterSpacing: '-0.02em',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {areaName}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.65 }}>
        <MetricRow label="Total requests" value={totalRequests.toLocaleString()} colors={colors} semantic={semantic} />
        <MetricRow label="Avg response time" value={formatHours(avgResponseHours)} colors={colors} semantic={semantic} />
        <MetricRow
          label="Unresolved rate"
          value={`${(unresolvedRate * 100).toFixed(1)}%`}
          valueColor={semantic.urgent}
          colors={colors}
          semantic={semantic}
        />
        <MetricRow
          label="High delay requests"
          value={highDelayCount.toLocaleString()}
          valueColor={semantic.urgent}
          colors={colors}
          semantic={semantic}
        />
      </Box>

      {insight && (
        <Typography
          sx={{
            fontSize: '0.8125rem',
            lineHeight: 1.55,
            color: semantic.muted,
            fontStyle: 'italic',
          }}
        >
          {insight}
        </Typography>
      )}

      <Divider sx={{ borderColor: alpha(semantic.track, 0.85), my: 0.25 }} />

      <Box>
        <Typography
          sx={{
            fontSize: '0.6875rem',
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: semantic.muted,
            mb: 0.75,
          }}
        >
          Top delay drivers
        </Typography>

        {topDrivers.length === 0 ? (
          <Typography sx={{ color: semantic.muted, fontSize: '0.8125rem' }}>
            No driver signals for the current filters.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.85 }}>
            {topDrivers.map((driver, index) => (
              <Box key={driver.key} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Typography
                  sx={{
                    fontWeight: 800,
                    fontSize: '0.6875rem',
                    color: semantic.muted,
                    minWidth: 14,
                    pt: 0.1,
                  }}
                >
                  {index + 1}
                </Typography>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography
                    sx={{
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      color: semantic.muted,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {driver.label}
                  </Typography>
                  <Typography
                    noWrap
                    sx={{
                      fontWeight: 700,
                      fontSize: '0.8125rem',
                      color: getDriverValueColor(driver, mode, semantic),
                      mt: 0.15,
                    }}
                  >
                    {driver.value}
                  </Typography>
                  <Typography sx={{ fontSize: '0.6875rem', color: semantic.muted, mt: 0.1 }}>
                    {driver.detail}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </AppCard>
  );
}
