import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Box, Stack, Typography, Tooltip, alpha } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useAppColors } from '../ColorModeContext';
import { buildShapContributionsInHours, getShapHourContext } from '../utils/mlExplanation';
import { formatShapContribution } from '../utils/analytics';
import {
  MODEL_ROW_HEIGHT,
  SHAP_CHART_HEIGHT,
  SHAP_FACTOR_LIMIT,
  cardSubtitleSx,
  cardTitleSx,
} from '../styles/modelViewLayout';
import DashboardCard from './DashboardCard';

// Pink ramp — increasing bars
const PINK_LIGHT = '#F9A8D4';
const PINK_MID = '#EC4899';
const PINK_DEEP = '#DB2777';

// Violet ramp — reducing bars
const PURPLE_LIGHT = '#C4B5FD';
const PURPLE_MID = '#8B5CF6';
const PURPLE_DEEP = '#7C3AED';

// Full descriptive labels — used in the tooltip
const FEATURE_LABELS = {
  borough_complaint_median: 'Borough historical delay',
  agency_complaint_median: 'Agency + complaint historical delay',
  complaint_median_hours: 'Complaint median response time',
  agency_zip_median: 'Agency + ZIP historical delay',
  agency_dow_median: 'Agency day-of-week historical delay',
  agency_median_hours: 'Agency median response time',
  agency_volume: 'Agency volume',
  agency_complaint_volume: 'Agency complaint load',
  agency_workload_24h: 'Recent agency workload (24h)',
  agency_workload_7d: 'Recent agency workload (7d)',
  incident_zip: 'Incident ZIP',
  urgency_score: 'Urgency score',
  complaint_type: 'Complaint type',
  open_data_channel_type: 'Submission channel',
  dow_complaint: 'Day-of-week × complaint',
  day_of_week: 'Day of week',
  month: 'Month / seasonality',
  borough: 'Borough effect',
  agency: 'Agency effect',
};

// Short display labels — shown on y-axis pills (feature keys unchanged for data lookup)
const FEATURE_DISPLAY_LABELS = {
  borough_complaint_median: 'Borough history',
  agency_complaint_median: 'Agency history',
  complaint_median_hours: 'Complaint median',
  agency_zip_median: 'ZIP history',
  agency_dow_median: 'Day-of-week history',
  agency_median_hours: 'Agency median',
  agency_volume: 'Agency volume',
  agency_complaint_volume: 'Agency load',
  agency_workload_24h: 'Workload 24h',
  agency_workload_7d: 'Workload 7d',
  incident_zip: 'Incident ZIP',
  urgency_score: 'Urgency score',
  complaint_type: 'Complaint type',
  open_data_channel_type: 'Channel',
  dow_complaint: 'Day × complaint',
  day_of_week: 'Day of week',
  month: 'Seasonality',
  borough: 'Borough',
  agency: 'Agency',
};

const PILL_LABEL_MAX = 22;

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function resolveLabel(row) {
  return row?.label || FEATURE_LABELS[row?.feature] || row?.feature || 'Unknown factor';
}

function truncateLabel(text, max = 26) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function humanizeFeature(feature) {
  if (!feature) return 'Unknown factor';
  const text = String(feature).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function resolveShortLabel(row) {
  const feature = row?.feature;
  if (feature && FEATURE_DISPLAY_LABELS[feature]) {
    return truncateLabel(FEATURE_DISPLAY_LABELS[feature], PILL_LABEL_MAX);
  }
  return truncateLabel(humanizeFeature(feature), PILL_LABEL_MAX);
}

function formatShapValue(value) {
  return formatShapContribution(Number(value) || 0);
}

function formatSpeedComparison(baseline, predicted) {
  const diff = baseline - predicted;
  const absDiff = Math.round(Math.abs(diff) * 10) / 10;
  if (absDiff < 0.05) return 'about the same speed';
  if (diff > 0) return `${absDiff.toFixed(1)}h faster`;
  return `${absDiff.toFixed(1)}h slower`;
}

function buildHeaderSummary(baseline, predicted) {
  return `Typical request: ${baseline.toFixed(1)}h  →  This request: ${predicted.toFixed(1)}h  (${formatSpeedComparison(baseline, predicted)})`;
}

function estimateLabelWidth(label) {
  return Math.max(30, String(label).length * 7.2);
}

/** Nudge SHAP value labels away from reference lines so they never sit on dashed/solid markers. */
function resolveShapLabelPosition({
  positive,
  x0,
  barW,
  bx,
  px,
  shapLabel,
}) {
  const BAR_GAP = 6;
  const LINE_PAD = 11;
  const labelW = estimateLabelWidth(shapLabel);

  const blockedZones = [
    [bx - LINE_PAD, bx + LINE_PAD],
    [px - LINE_PAD, px + LINE_PAD],
  ];

  const bbox = (x, anchor) => (
    anchor === 'start' ? [x, x + labelW] : [x - labelW, x]
  );

  const hitsZone = ([left, right]) => (
    blockedZones.some(([zoneLeft, zoneRight]) => left < zoneRight && right > zoneLeft)
  );

  const candidates = positive
    ? [
      { x: x0 + barW + BAR_GAP, anchor: 'start' },
      { x: x0 - BAR_GAP, anchor: 'end' },
      { x: bx + LINE_PAD, anchor: 'start' },
      { x: px + LINE_PAD, anchor: 'start' },
    ]
    : [
      { x: x0 - BAR_GAP, anchor: 'end' },
      { x: x0 + barW + BAR_GAP, anchor: 'start' },
      { x: bx - LINE_PAD, anchor: 'end' },
      { x: px - LINE_PAD, anchor: 'end' },
    ];

  const clear = candidates.find((candidate) => !hitsZone(bbox(candidate.x, candidate.anchor)));
  if (clear) return clear;

  const fallback = positive
    ? { x: Math.max(x0 + barW + BAR_GAP, bx + LINE_PAD, px + LINE_PAD), anchor: 'start' }
    : { x: Math.min(x0 - BAR_GAP, bx - LINE_PAD, px - LINE_PAD), anchor: 'end' };

  return fallback;
}

/** Padded x-domain from waterfall extent — tight to this case's bar span only. */
function computeWaterfallXDomain(baseline, predicted, steps) {
  const allX = [baseline, predicted, ...steps.flatMap((s) => [s.runStart, s.runEnd])];
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  const span = Math.max(xMax - xMin, 0);

  const xPad = span > 0
    ? Math.max(span * 0.12, 0.15)
    : Math.max(Math.abs(predicted) * 0.05, 0.5);

  return { xMin, xMax, domain: [xMin - xPad, xMax + xPad] };
}

/** Place reference-line labels in a header strip without horizontal overlap. */
function resolveReferenceLabelLayout(bx, px, baselineHours, predictedHours) {
  const baselineText = `Typical case: ${baselineHours.toFixed(1)}h`;
  const predictionText = `This request: ${predictedHours.toFixed(1)}h`;
  const baselineW = estimateLabelWidth(baselineText);
  const predictionW = estimateLabelWidth(predictionText);
  const minGap = 10;

  const baselineLabel = {
    text: baselineText,
    x: bx,
    y: 10,
    anchor: 'middle',
  };
  const predictionLabel = {
    text: predictionText,
    x: px,
    y: 20,
    anchor: 'middle',
  };

  const baselineBox = () => {
    if (baselineLabel.anchor === 'start') return [baselineLabel.x, baselineLabel.x + baselineW];
    if (baselineLabel.anchor === 'end') return [baselineLabel.x - baselineW, baselineLabel.x];
    return [baselineLabel.x - baselineW / 2, baselineLabel.x + baselineW / 2];
  };
  const predictionBox = () => {
    if (predictionLabel.anchor === 'start') return [predictionLabel.x, predictionLabel.x + predictionW];
    if (predictionLabel.anchor === 'end') return [predictionLabel.x - predictionW, predictionLabel.x];
    return [predictionLabel.x - predictionW / 2, predictionLabel.x + predictionW / 2];
  };

  const overlaps = () => {
    const [b0, b1] = baselineBox();
    const [p0, p1] = predictionBox();
    return b0 < p1 + minGap && p0 < b1 + minGap;
  };

  if (Math.abs(bx - px) < Math.max(baselineW, predictionW) + minGap || overlaps()) {
    if (bx <= px) {
      baselineLabel.anchor = 'end';
      baselineLabel.x = bx - 6;
      predictionLabel.anchor = 'start';
      predictionLabel.x = px + 6;
    } else {
      baselineLabel.anchor = 'start';
      baselineLabel.x = bx + 6;
      predictionLabel.anchor = 'end';
      predictionLabel.x = px - 6;
    }
  }

  if (overlaps()) {
    baselineLabel.y = 8;
    predictionLabel.y = 20;
    if (bx <= px) {
      baselineLabel.x = Math.min(bx, px) - 6;
      baselineLabel.anchor = 'end';
      predictionLabel.x = Math.max(bx, px) + 6;
      predictionLabel.anchor = 'start';
    } else {
      baselineLabel.x = Math.max(bx, px) - 6;
      baselineLabel.anchor = 'end';
      predictionLabel.x = Math.min(bx, px) + 6;
      predictionLabel.anchor = 'start';
    }
  }

  return { baselineLabel, predictionLabel };
}

function pickTickCount(plotWidth, domainSpan) {
  if (domainSpan <= 8) return plotWidth < 300 ? 4 : 5;
  if (domainSpan <= 40) return plotWidth < 320 ? 4 : 5;
  if (domainSpan <= 120) return 5;
  return plotWidth < 360 ? 4 : 5;
}

function formatFeatureValue(feature, value) {
  if (value == null || value === '' || value === '—') return null;
  if (feature === 'month') return MONTH_NAMES[Number(value)] ?? String(value);
  if (feature === 'agency_workload_24h') return `${Number(value).toFixed(0)} requests`;
  if (feature?.includes('median')) return `${Number(value).toFixed(1)} h`;
  return String(value);
}

// Detects whether a color token is dark, so the label pills can flip for the theme
function isDarkColor(c) {
  if (!c || typeof c !== 'string') return true;
  let r = 0, g = 0, b = 0;
  if (c[0] === '#') {
    const h = c.slice(1);
    const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
    r = parseInt(v.slice(0, 2), 16);
    g = parseInt(v.slice(2, 4), 16);
    b = parseInt(v.slice(4, 6), 16);
  } else {
    const m = c.match(/\d+(\.\d+)?/g);
    if (m) [r, g, b] = m.map(Number);
  }
  return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
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

export default function ShapExplanationPanel({ request }) {
  const colors = useAppColors();
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  // Measure both width AND height so the chart fills the card; the leftover
  // space below the axis then matches the card's 22px side padding.
  const [dims, setDims] = useState({ width: 720, height: SHAP_CHART_HEIGHT });
  const [tooltip, setTooltip] = useState(null);

  const { baselineHours, predictedHours } = useMemo(
    () => getShapHourContext(request ?? {}),
    [request],
  );

  const factors = useMemo(() => {
    return buildShapContributionsInHours(request, { limit: SHAP_FACTOR_LIMIT })
      .map((row) => ({
        ...row,
        label: resolveLabel(row),
        shortLabel: resolveShortLabel(row),
        shap: Number(row.shap) || 0,
      }));
  }, [request]);

  // Cumulative waterfall steps: each bar walks from its runStart to runEnd (hour space)
  const steps = useMemo(() => {
    let running = baselineHours;
    return factors.map((d) => {
      const runStart = running;
      running += d.shap;
      return { ...d, runStart, runEnd: running };
    });
  }, [factors, baselineHours]);

  const headerSummary = useMemo(
    () => buildHeaderSummary(baselineHours, predictedHours),
    [baselineHours, predictedHours],
  );

  const positiveColor = PINK_MID;    // pink — increases
  const negativeColor = PURPLE_MID;  // violet — reduces

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      if (w > 0 && h > 0) setDims({ width: w, height: h });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || !steps.length) return;

    const { width, height } = dims;
    // Symmetric bottom: small bottom margin so the axis sits near the chart
    // edge, leaving only the card's 22px padding below it (matches the sides).
    const ANNOT_STRIP_HEIGHT = 26;
    const margin = { top: 28 + ANNOT_STRIP_HEIGHT, right: 60, bottom: 24, left: 14 };
    const labelColWidth = Math.min(186, Math.max(136, width * 0.3));
    const plotLeft = margin.left + labelColWidth;
    const plotWidth = Math.max(120, width - plotLeft - margin.right);
    const plotHeight = Math.max(80, height - margin.top - margin.bottom);
    const rowStep = plotHeight / steps.length;
    const barHeight = Math.min(26, Math.max(12, rowStep - 10));

    const { domain: xDomain } = computeWaterfallXDomain(baselineHours, predictedHours, steps);
    const domainSpan = xDomain[1] - xDomain[0];
    const tickCount = pickTickCount(plotWidth, domainSpan);
    const xScale = d3.scaleLinear()
      .domain(xDomain)
      .range([0, plotWidth]);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg
      .attr('width', '100%')
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', 'Waterfall chart showing factors that raise or lower expected response time compared with a typical request');

    const defs = svg.append('defs');
    // Pink gradient — increases, light → deep
    const posGrad = defs.append('linearGradient').attr('id', 'wf-pos').attr('x1', '0%').attr('x2', '100%');
    posGrad.append('stop').attr('offset', '0%').attr('stop-color', PINK_LIGHT).attr('stop-opacity', 0.9);
    posGrad.append('stop').attr('offset', '100%').attr('stop-color', PINK_DEEP).attr('stop-opacity', 0.95);
    // Violet gradient — reduces, light → deep
    const negGrad = defs.append('linearGradient').attr('id', 'wf-neg').attr('x1', '100%').attr('x2', '0%');
    negGrad.append('stop').attr('offset', '0%').attr('stop-color', PURPLE_LIGHT).attr('stop-opacity', 0.9);
    negGrad.append('stop').attr('offset', '100%').attr('stop-color', PURPLE_DEEP).attr('stop-opacity', 0.95);

    const plot = svg.append('g').attr('transform', `translate(${plotLeft},${margin.top})`);

    // Plot background
    plot.append('rect')
      .attr('width', plotWidth).attr('height', plotHeight)
      .attr('rx', 6)
      .attr('fill', colors.chartPlotBg)
      .attr('stroke', colors.border);

    // Grid + x-axis ticks — generated within the tight domain (no .nice() widening)
    const ticks = d3.ticks(xDomain[0], xDomain[1], tickCount);
    ticks.forEach((t) => {
      plot.append('line')
        .attr('x1', xScale(t)).attr('x2', xScale(t))
        .attr('y1', 0).attr('y2', plotHeight)
        .attr('stroke', colors.gridStroke)
        .attr('stroke-width', 1);
      plot.append('text')
        .attr('x', xScale(t)).attr('y', plotHeight + 17)
        .attr('text-anchor', 'middle')
        .attr('fill', colors.chartLabel)
        .attr('font-size', 12)
        .text(`${t}h`);
    });

    const bx = xScale(baselineHours);
    const px = xScale(predictedHours);
    const { baselineLabel, predictionLabel } = resolveReferenceLabelLayout(bx, px, baselineHours, predictedHours);

    // Annotation strip above plot — staggered labels with collision avoidance
    const annotGroup = svg.append('g').attr('transform', `translate(${plotLeft}, ${margin.top - ANNOT_STRIP_HEIGHT})`);
    annotGroup.append('text')
      .attr('x', baselineLabel.x)
      .attr('y', baselineLabel.y)
      .attr('text-anchor', baselineLabel.anchor)
      .attr('fill', colors.chartLabel)
      .attr('font-size', 10)
      .attr('font-weight', 700)
      .text(baselineLabel.text);
    annotGroup.append('text')
      .attr('x', predictionLabel.x)
      .attr('y', predictionLabel.y)
      .attr('text-anchor', predictionLabel.anchor)
      .attr('fill', colors.primary)
      .attr('font-size', 10)
      .attr('font-weight', 700)
      .text(predictionLabel.text);

    // Baseline dashed marker — typical case
    plot.append('line')
      .attr('x1', bx).attr('x2', bx)
      .attr('y1', 0).attr('y2', plotHeight)
      .attr('stroke', colors.chartLabel)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,3')
      .attr('opacity', 0.75);

    // Prediction solid marker — this request
    plot.append('line')
      .attr('x1', px).attr('x2', px)
      .attr('y1', 0).attr('y2', plotHeight)
      .attr('stroke', colors.primary)
      .attr('stroke-width', 2)
      .attr('opacity', 0.9);

    // Feature labels (left column) — uniform-width pink pills, centered, theme-aware
    const darkMode = isDarkColor(colors.chartPlotBg);
    const pillFill = darkMode ? 'rgba(236,72,153,0.18)' : 'rgba(236,72,153,0.12)';
    const pillStroke = darkMode ? 'rgba(236,72,153,0.34)' : 'rgba(219,39,119,0.30)';
    const pillText = darkMode ? '#F9A8D4' : '#BE185D';
    const pillW = labelColWidth - 12;
    const pillH = Math.min(30, Math.max(20, rowStep - 8));
    const pillRight = labelColWidth - 4; // right edge sits just left of the plot
    const labelGroup = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    steps.forEach((d, i) => {
      const cy = i * rowStep + rowStep / 2;
      labelGroup.append('rect')
        .attr('x', pillRight - pillW)
        .attr('y', cy - pillH / 2)
        .attr('width', pillW)
        .attr('height', pillH)
        .attr('rx', 8)
        .attr('fill', pillFill)
        .attr('stroke', pillStroke)
        .attr('stroke-width', 1);
      labelGroup.append('text')
        .attr('x', pillRight - pillW / 2)
        .attr('y', cy)
        .attr('dy', '0.32em')
        .attr('text-anchor', 'middle')
        .attr('fill', pillText)
        .attr('font-size', 13)
        .attr('font-weight', 600)
        .text(d.shortLabel);
    });

    // Step connectors — thin vertical lines linking the end of bar i-1 to start of bar i
    steps.forEach((d, i) => {
      if (i === 0) return;
      const cx = xScale(d.runStart);
      const y1 = (i - 1) * rowStep + (rowStep - barHeight) / 2 + barHeight / 2;
      const y2 = i * rowStep + (rowStep - barHeight) / 2 + barHeight / 2;
      plot.append('line')
        .attr('x1', cx).attr('x2', cx)
        .attr('y1', y1).attr('y2', y2)
        .attr('stroke', colors.border)
        .attr('stroke-width', 1)
        .attr('opacity', 0.85);
    });

    // Waterfall bars
    steps.forEach((d, i) => {
      const positive = d.shap >= 0;
      const x0 = xScale(Math.min(d.runStart, d.runEnd));
      const barW = Math.max(2, Math.abs(xScale(d.runEnd) - xScale(d.runStart)));
      const yTop = i * rowStep + (rowStep - barHeight) / 2;
      const featureVal = formatFeatureValue(d.feature, d.value);

      const g = plot.append('g').attr('transform', `translate(0,${yTop})`);

      g.append('rect')
        .attr('x', x0).attr('y', 0)
        .attr('width', barW).attr('height', barHeight)
        .attr('rx', 4)
        .attr('fill', positive ? 'url(#wf-pos)' : 'url(#wf-neg)')
        .attr('stroke', positive ? alpha(positiveColor, 0.65) : alpha(negativeColor, 0.65))
        .attr('stroke-width', 1)
        .attr('tabindex', '0')
        .attr('role', 'button')
        .attr('aria-label', `${d.label}: ${formatShapValue(d.shap)} hours, running total ${d.runEnd.toFixed(2)} hours`)
        .style('cursor', 'pointer')
        .style('outline', 'none')
        .on('mouseenter', function onEnter(event) {
          d3.select(this).attr('opacity', 0.82);
          setTooltip({ x: event.offsetX, y: event.offsetY, row: { ...d, featureVal } });
        })
        .on('mousemove', (event) => {
          setTooltip((prev) => (prev ? { ...prev, x: event.offsetX, y: event.offsetY } : prev));
        })
        .on('mouseleave', function onLeave() {
          d3.select(this).attr('opacity', 1);
          setTooltip(null);
        })
        .on('focus', function onFocus() {
          d3.select(this).attr('opacity', 0.82);
          setTooltip({ x: plotLeft + x0 + barW / 2, y: margin.top + yTop, row: { ...d, featureVal } });
        })
        .on('blur', function onBlur() {
          d3.select(this).attr('opacity', 1);
          setTooltip(null);
        });

      const shapLabel = formatShapValue(d.shap);
      const { x: labelX, anchor: labelAnchor } = resolveShapLabelPosition({
        positive,
        x0,
        barW,
        bx,
        px,
        shapLabel,
      });
      g.append('text')
        .attr('x', labelX).attr('y', barHeight / 2)
        .attr('dy', '0.32em')
        .attr('text-anchor', labelAnchor)
        .attr('fill', positive ? positiveColor : negativeColor)
        .attr('font-size', 13)
        .attr('font-weight', 800)
        .attr('pointer-events', 'none')
        .text(shapLabel);
    });
  }, [steps, dims, colors, positiveColor, negativeColor, baselineHours, predictedHours]);

  return (
    <DashboardCard sx={{ width: '100%' }} contentSx={cardShellSx}>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mb: 0.75, flexShrink: 0 }}>
        <Typography variant="subtitle2" sx={{ ...cardTitleSx, color: colors.textSecondary }}>
          Explanation
        </Typography>
        <Tooltip
          title="Each bar shows what pushes the expected wait up or down compared with a typical similar request."
          arrow
          placement="top"
        >
          <InfoOutlinedIcon sx={{ fontSize: 14, color: colors.textSecondary, cursor: 'help' }} />
        </Tooltip>
      </Stack>

      {!request ? (
        <Typography variant="body2" sx={{ ...cardSubtitleSx, color: colors.textSecondary, py: 2, textAlign: 'center' }}>
          No case selected.
        </Typography>
      ) : (
        <>
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              mb: 0.75,
              flexShrink: 0,
              fontSize: '0.72rem',
              fontVariantNumeric: 'tabular-nums',
              color: colors.textSecondary,
              lineHeight: 1.45,
            }}
          >
            {headerSummary}
          </Typography>

          <Stack
            direction="row"
            spacing={1.75}
            sx={{ mb: 0.75, flexShrink: 0, alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}
          >
            <Stack direction="row" spacing={0.6} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '2px',
                  bgcolor: PINK_MID,
                  flexShrink: 0,
                }}
              />
              <Typography
                variant="caption"
                sx={{ fontSize: '0.72rem', color: colors.textSecondary, lineHeight: 1.2 }}
              >
                Increases delay
              </Typography>
            </Stack>
            <Stack direction="row" spacing={0.6} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '2px',
                  bgcolor: PURPLE_MID,
                  flexShrink: 0,
                }}
              />
              <Typography
                variant="caption"
                sx={{ fontSize: '0.72rem', color: colors.textSecondary, lineHeight: 1.2 }}
              >
                Decreases delay
              </Typography>
            </Stack>
          </Stack>

          <Box
            ref={containerRef}
            sx={{
              position: 'relative',
              width: '100%',
              flex: 1,
              minHeight: 0,
              borderRadius: '14px',
              border: `1px solid ${colors.border}`,
              bgcolor: colors.chartPlotBg,
              overflow: 'visible',
              display: 'flex',
              alignItems: 'stretch',
            }}
          >
            <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />

            {tooltip && (
              <Box
                sx={{
                  position: 'absolute',
                  left: Math.min(tooltip.x + 14, dims.width - 264),
                  top: Math.max(tooltip.y - 14, 4),
                  maxWidth: 260,
                  p: 1.4,
                  borderRadius: 2,
                  bgcolor: alpha(colors.tooltipBg, 0.98),
                  border: `1px solid ${alpha(tooltip.row.shap >= 0 ? positiveColor : negativeColor, 0.35)}`,
                  boxShadow: `0 8px 20px ${alpha('#000', 0.14)}`,
                  pointerEvents: 'none',
                  zIndex: 3,
                }}
              >
                {/* Tooltip starts directly at the human-readable label (raw feature key removed) */}
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 800, color: colors.textPrimary, lineHeight: 1.35, fontSize: '0.8125rem' }}
                >
                  {tooltip.row.label}
                </Typography>
                {tooltip.row.featureVal != null && (
                  <Typography variant="caption" sx={{ display: 'block', color: colors.textSecondary, mt: 0.4, fontSize: '0.72rem' }}>
                    {'Value: '}
                    <Box component="span" sx={{ fontWeight: 700, color: colors.textPrimary }}>
                      {tooltip.row.featureVal}
                    </Box>
                  </Typography>
                )}
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    fontWeight: 700,
                    color: tooltip.row.shap >= 0 ? positiveColor : negativeColor,
                    mt: 0.4,
                    fontSize: '0.75rem',
                  }}
                >
                  Contribution: {formatShapValue(tooltip.row.shap)} h
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: colors.textSecondary, mt: 0.25, fontSize: '0.72rem' }}>
                  {'Running total: '}
                  <Box component="span" sx={{ fontWeight: 700, color: colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
                    {tooltip.row.runEnd.toFixed(2)} h
                  </Box>
                </Typography>
              </Box>
            )}
          </Box>
        </>
      )}
    </DashboardCard>
  );
}