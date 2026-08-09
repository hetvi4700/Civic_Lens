import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  Typography,
  Box,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  alpha,
} from '@mui/material';
import ChartTooltip from './ChartTooltip';
import TimelineIcon from '@mui/icons-material/Timeline';
import { useAppColors, useColorMode } from '../ColorModeContext';
import {
  getDashboardSemanticColors,
  getTimelineLineColors,
  getTimelineRequestBarColor,
} from '../styles/dashboardColors';
import { getDelayBucketColorMap } from '../utils/mapHelpers';
import { formatHours } from '../utils/analytics';
import GlassChartCard from './GlassChartCard';
import VizSectionHeader from './VizSectionHeader';

const MODE_SUBTITLES = {
  resolved: 'Monthly volume and actual resolution time for closed requests.',
  unresolved: 'Monthly volume and model-predicted resolution time for open requests.',
};

const HOURS_BANDS = [
  { y1: 0, y2: 24, colorKey: 'Same Day', label: 'Same Day', opacity: 0.06 },
  { y1: 24, y2: 72, colorKey: '1–3 Days', label: '1-3 Days', opacity: 0.08 },
  { y1: 72, y2: 168, colorKey: '3–7 Days', label: '3-7 Days', opacity: 0.1 },
  { y1: 168, colorKey: 'More than 1 Week', label: '7+ Days', opacity: 0.12 },
];

const STACK_BUCKETS = [
  { dataKey: 'count_same_day', name: 'Same Day', colorKey: 'Same Day', tooltipLabel: 'Same Day' },
  { dataKey: 'count_1_3', name: '1-3 Days', colorKey: '1–3 Days', tooltipLabel: '1-3 Days' },
  { dataKey: 'count_3_7', name: '3-7 Days', colorKey: '3–7 Days', tooltipLabel: '3-7 Days' },
  { dataKey: 'count_7plus', name: '7+ Days', colorKey: 'More than 1 Week', tooltipLabel: '7+ Days' },
];

const BRUSH_HEIGHT = 20;
const MAX_BAR_WIDTH = 42;
const LEFT_AXIS_WIDTH = 56;
const RIGHT_AXIS_WIDTH = 48;

function formatCountTick(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  if (Math.abs(numeric) >= 1000) return `${Math.round(numeric / 1000)}k`;
  return String(Math.round(numeric));
}

function resolveChartHeight(plotHeight) {
  if (typeof plotHeight === 'number' && plotHeight > 0) return plotHeight;
  return 360;
}

function formatMonthYear(entry) {
  if (entry?.label) return entry.label;
  if (entry?.month && entry?.year) {
    const date = new Date(entry.year, entry.month - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  return '';
}

export function detectAnomalies(data, key, threshold = 2) {
  const values = data
    .map((entry) => entry[key])
    .filter((value) => value != null && Number.isFinite(Number(value)))
    .map(Number);

  if (!values.length) {
    return data.map((entry) => ({ ...entry, [`${key}_anomaly`]: false }));
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);

  return data.map((entry) => {
    const raw = entry[key];
    const numeric = Number(raw);
    const isAnomaly = Number.isFinite(numeric)
      && std > 0
      && Math.abs((numeric - mean) / std) > threshold;

    return { ...entry, [`${key}_anomaly`]: isAnomaly };
  });
}

function hasBucketBreakdown(entries) {
  return (entries || []).some((entry) => STACK_BUCKETS.some(
    ({ dataKey }) => entry[dataKey] != null && Number(entry[dataKey]) > 0,
  ));
}

function normalizeResolvedEntry(entry) {
  return {
    ...entry,
    xLabel: formatMonthYear(entry),
    count: entry.resolvedCount ?? entry.count ?? 0,
    avgResponseHours: entry.avgResponseHours ?? entry.avgActual ?? 0,
    count_same_day: entry.count_same_day,
    count_1_3: entry.count_1_3,
    count_3_7: entry.count_3_7,
    count_7plus: entry.count_7plus,
    top_complaint_type: entry.top_complaint_type ?? entry.topComplaintType,
  };
}

function normalizeUnresolvedEntry(entry) {
  const totalCount = entry.count ?? 0;
  const unresolvedCount = entry.unresolvedCount ?? (
    entry.unresolvedRate != null
      ? Math.round(totalCount * entry.unresolvedRate)
      : totalCount
  );

  return {
    ...entry,
    xLabel: formatMonthYear(entry),
    count: unresolvedCount,
    avgPredictedHours: entry.avgPredictedHours ?? entry.avgPredicted ?? 0,
    count_same_day: entry.count_same_day,
    count_1_3: entry.count_1_3,
    count_3_7: entry.count_3_7,
    count_7plus: entry.count_7plus,
    top_complaint_type: entry.top_complaint_type ?? entry.topComplaintType,
  };
}

function buildTooltipRows(row, viewMode, bucketColors, useStackedBars) {
  const rows = [];

  if (row.count != null) {
    rows.push({
      label: 'Total requests',
      value: Number(row.count ?? 0).toLocaleString(),
      emphasize: true,
    });
  }

  if (useStackedBars) {
    STACK_BUCKETS.forEach(({ dataKey, tooltipLabel, colorKey }) => {
      const value = row[dataKey];
      if (value == null) return;
      rows.push({
        label: tooltipLabel,
        value: Number(value).toLocaleString(),
        color: bucketColors[colorKey],
      });
    });
  }

  if (viewMode === 'resolved' && row.avgResponseHours != null) {
    rows.push({
      label: 'Avg actual',
      value: formatHours(row.avgResponseHours ?? 0),
    });
  } else if (viewMode === 'unresolved' && row.avgPredictedHours != null) {
    rows.push({
      label: 'Avg predicted',
      value: formatHours(row.avgPredictedHours ?? 0),
    });
  }

  if (row.unresolvedRate != null) {
    rows.push({
      label: 'Unresolved rate',
      value: `${(Number(row.unresolvedRate) * 100).toFixed(1)}%`,
    });
  }

  const topComplaint = row.top_complaint_type;
  if (topComplaint) {
    rows.push({
      label: 'Top complaint',
      value: String(topComplaint),
    });
  }

  return rows;
}

function defaultBrushRange(length) {
  if (length <= 0) return [0, 0];
  const start = length > 8 ? length - 8 : 0;
  return [start, length - 1];
}

function pickXTicks(labels, innerWidth) {
  if (labels.length <= 1) return labels;
  const maxTicks = Math.max(2, Math.floor(innerWidth / 72));
  if (labels.length <= maxTicks) return labels;
  const step = Math.ceil((labels.length - 1) / (maxTicks - 1));
  const ticks = [labels[0]];
  for (let i = step; i < labels.length - 1; i += step) {
    ticks.push(labels[i]);
  }
  if (ticks[ticks.length - 1] !== labels[labels.length - 1]) {
    ticks.push(labels[labels.length - 1]);
  }
  return ticks;
}

function brushIndexFromX(px, scale, length) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < length; i += 1) {
    const cx = (scale(String(i)) ?? 0) + scale.bandwidth() / 2;
    const dist = Math.abs(px - cx);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function getLegendItems(viewMode, useStackedBars, bucketColors, lineColors, requestCountBarColor) {
  if (useStackedBars) {
    return [
      ...STACK_BUCKETS.map(({ name, colorKey }) => ({
        label: name,
        swatch: bucketColors[colorKey],
        type: 'rect',
      })),
      viewMode === 'resolved'
        ? { label: 'Avg Response Hours', swatch: lineColors.response, type: 'line' }
        : { label: 'Avg Predicted Hours', swatch: lineColors.predicted, type: 'line-dashed' },
    ];
  }

  return [
    {
      label: viewMode === 'resolved' ? 'Resolved Requests' : 'Open Requests',
      swatch: requestCountBarColor,
      type: 'rect',
    },
    viewMode === 'resolved'
      ? { label: 'Avg Response Hours', swatch: lineColors.response, type: 'line' }
      : { label: 'Avg Predicted Hours', swatch: lineColors.predicted, type: 'line-dashed' },
  ];
}

export default function DelayTimeline({
  timelineData = [],
  resolvedData,
  unresolvedData,
  selectedBorough = null,
  title = 'Delay & Complaint Timeline',
  subtitle = 'Tracks monthly request volume, actual response time, predicted response time, and unresolved rate.',
  plotHeight,
  compactFooter = false,
}) {
  const colors = useAppColors();
  const { mode } = useColorMode();
  const semantic = useMemo(() => getDashboardSemanticColors(colors, mode), [colors, mode]);
  const requestCountBarColor = useMemo(
    () => getTimelineRequestBarColor(selectedBorough, mode),
    [selectedBorough, mode],
  );
  const lineColors = useMemo(() => getTimelineLineColors(mode), [mode]);
  const bucketColors = useMemo(() => getDelayBucketColorMap(mode), [mode]);
  const [viewMode, setViewMode] = useState('resolved');
  const [brushRange, setBrushRange] = useState([0, 0]);
  const [tooltip, setTooltip] = useState(null);
  const [dimensions, setDimensions] = useState({ width: 560, height: 360 });

  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const brushRangeRef = useRef(brushRange);

  brushRangeRef.current = brushRange;

  const resolvedSource = resolvedData ?? timelineData;
  const unresolvedSource = unresolvedData ?? timelineData;

  const chartData = useMemo(() => {
    const source = viewMode === 'resolved' ? resolvedSource : unresolvedSource;
    const normalized = (source || []).map(
      viewMode === 'resolved' ? normalizeResolvedEntry : normalizeUnresolvedEntry,
    ).map((entry, index, arr) => ({
      ...entry,
      isIncomplete: viewMode === 'resolved' && arr.length > 1 && index >= arr.length - 2,
    }));

    const hoursKey = viewMode === 'resolved' ? 'avgResponseHours' : 'avgPredictedHours';
    return detectAnomalies(normalized, hoursKey);
  }, [viewMode, resolvedSource, unresolvedSource]);

  const useStackedBars = useMemo(() => hasBucketBreakdown(chartData), [chartData]);

  const hoursKey = viewMode === 'resolved' ? 'avgResponseHours' : 'avgPredictedHours';
  const lineColor = viewMode === 'resolved' ? lineColors.response : lineColors.predicted;
  const hasLineAnomalies = chartData.some((entry) => entry[`${hoursKey}_anomaly`]);
  const dotStrokeColor = mode === 'light' ? '#ffffff' : colors.background;

  const hoursDomainMax = useMemo(() => {
    const values = chartData
      .map((entry) => Number(entry[hoursKey]))
      .filter((value) => Number.isFinite(value));
    const dataMax = values.length ? Math.max(...values) : 0;
    return Math.max(180, Math.ceil(Math.max(dataMax, 168) / 45) * 45);
  }, [chartData, hoursKey]);

  const chartHeight = resolveChartHeight(plotHeight);
  const activeSubtitle = MODE_SUBTITLES[viewMode] ?? subtitle;
  const legendHeight = compactFooter
    ? (useStackedBars ? 44 : 30)
    : (useStackedBars ? 52 : 36);
  const brushEnabled = chartData.length > 4 && !compactFooter;

  useEffect(() => {
    setBrushRange(defaultBrushRange(chartData.length));
    setTooltip(null);
  }, [chartData, viewMode, compactFooter]);

  const visibleData = useMemo(() => {
    if (!chartData.length) return [];
    if (!brushEnabled) return chartData;
    const [start, end] = brushRange;
    const safeStart = Math.max(0, Math.min(start, chartData.length - 1));
    const safeEnd = Math.max(safeStart, Math.min(end, chartData.length - 1));
    return chartData.slice(safeStart, safeEnd + 1);
  }, [chartData, brushRange, brushEnabled]);

  const legendItems = useMemo(
    () => getLegendItems(viewMode, useStackedBars, bucketColors, lineColors, requestCountBarColor),
    [viewMode, useStackedBars, bucketColors, lineColors, requestCountBarColor],
  );

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDimensions({ width, height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const handleBrushRangeChange = useCallback((start, end) => {
    setBrushRange([start, end]);
  }, []);

  useEffect(() => {
    if (!svgRef.current || !visibleData.length) return undefined;

    const { width, height } = dimensions;
    const topMargin = 8 + legendHeight;
    const bottomMargin = brushEnabled ? BRUSH_HEIGHT + 12 : (compactFooter ? 28 : 8);
    const margin = {
      top: topMargin,
      right: 6 + RIGHT_AXIS_WIDTH,
      left: 10 + LEFT_AXIS_WIDTH,
      bottom: bottomMargin,
    };

    const brushGap = 6;
    const mainInnerHeight = Math.max(
      80,
      height - margin.top - margin.bottom - (brushEnabled ? BRUSH_HEIGHT + brushGap : 0),
    );
    const innerWidth = Math.max(80, width - margin.left - margin.right);

    const xLabels = visibleData.map((d) => d.xLabel);
    const xScale = d3.scaleBand()
      .domain(xLabels)
      .range([0, innerWidth])
      .padding(0.22);

    const maxCount = d3.max(visibleData, (d) => {
      if (useStackedBars) {
        return STACK_BUCKETS.reduce((sum, { dataKey }) => sum + (Number(d[dataKey]) || 0), 0);
      }
      return Number(d.count) || 0;
    }) || 1;

    const yCount = d3.scaleLinear()
      .domain([0, maxCount])
      .nice()
      .range([mainInnerHeight, 0]);

    const yHours = d3.scaleLinear()
      .domain([0, hoursDomainMax])
      .range([mainInnerHeight, 0]);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', 'Monthly delay and request volume timeline');

    const root = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Top legend
    const legendGroup = svg.append('g').attr('transform', `translate(${margin.left},8)`);
    let legendX = 0;
    const legendItemGap = 14;
    legendItems.forEach((item) => {
      const itemG = legendGroup.append('g').attr('transform', `translate(${legendX},0)`);
      if (item.type === 'rect') {
        itemG.append('rect')
          .attr('width', 10)
          .attr('height', 10)
          .attr('rx', 2)
          .attr('fill', item.swatch);
      } else if (item.type === 'line-dashed') {
        itemG.append('line')
          .attr('x1', 0)
          .attr('x2', 14)
          .attr('y1', 5)
          .attr('y2', 5)
          .attr('stroke', item.swatch)
          .attr('stroke-width', 2.5)
          .attr('stroke-dasharray', '6 4');
      } else {
        itemG.append('line')
          .attr('x1', 0)
          .attr('x2', 14)
          .attr('y1', 5)
          .attr('y2', 5)
          .attr('stroke', item.swatch)
          .attr('stroke-width', 2.5);
      }
      const label = itemG.append('text')
        .attr('x', 18)
        .attr('y', 10)
        .attr('fill', colors.textSecondary)
        .attr('font-size', 11)
        .text(item.label);
      legendX += (label.node()?.getComputedTextLength?.() ?? item.label.length * 6.5) + 18 + legendItemGap;
    });

    // Hours reference bands
    HOURS_BANDS.forEach(({ y1, y2, colorKey, opacity }) => {
      root.append('rect')
        .attr('x', 0)
        .attr('y', yHours(y2 ?? hoursDomainMax))
        .attr('width', innerWidth)
        .attr('height', yHours(y1) - yHours(y2 ?? hoursDomainMax))
        .attr('fill', alpha(bucketColors[colorKey], opacity))
        .attr('pointer-events', 'none');
    });

    // Horizontal grid
    yCount.ticks(5).forEach((tick) => {
      root.append('line')
        .attr('x1', 0)
        .attr('x2', innerWidth)
        .attr('y1', yCount(tick))
        .attr('y2', yCount(tick))
        .attr('stroke', semantic.grid)
        .attr('stroke-dasharray', '3 3')
        .attr('pointer-events', 'none');
    });

    // Axes
    const xTickValues = pickXTicks(xLabels, innerWidth);
    root.append('g')
      .attr('transform', `translate(0,${mainInnerHeight})`)
      .call(
        d3.axisBottom(xScale)
          .tickValues(xTickValues)
          .tickSize(4),
      )
      .call((g) => g.selectAll('text').attr('fill', semantic.muted).attr('font-size', 11))
      .call((g) => g.select('.domain').attr('stroke', colors.border))
      .call((g) => g.selectAll('.tick line').attr('stroke', colors.border));

    root.append('g')
      .call(
        d3.axisLeft(yCount)
          .ticks(5)
          .tickSize(0)
          .tickFormat(formatCountTick),
      )
      .call((g) => g.selectAll('text').attr('fill', semantic.muted).attr('font-size', 11))
      .call((g) => g.select('.domain').attr('stroke', alpha(requestCountBarColor, 0.35)));

    root.append('g')
      .attr('transform', `translate(${innerWidth},0)`)
      .call(
        d3.axisRight(yHours)
          .ticks(5)
          .tickSize(0)
          .tickFormat((v) => `${v}h`),
      )
      .call((g) => g.selectAll('text').attr('fill', semantic.muted).attr('font-size', 11))
      .call((g) => g.select('.domain').attr('stroke', alpha(lineColor, 0.35)));

    // Bars
    if (useStackedBars) {
      const stack = d3.stack()
        .keys(STACK_BUCKETS.map((b) => b.dataKey))
        .value((d, key) => Number(d[key]) || 0);

      const series = stack(visibleData);
      const barWidth = Math.min(xScale.bandwidth(), MAX_BAR_WIDTH);
      const barOffset = (xScale.bandwidth() - barWidth) / 2;

      series.forEach((layer, layerIndex) => {
        const { dataKey, colorKey } = STACK_BUCKETS[layerIndex];
        const isTop = layerIndex === STACK_BUCKETS.length - 1;

        root.selectAll(`.stack-bar-${dataKey}`)
          .data(layer)
          .join('rect')
          .attr('class', `stack-bar-${dataKey}`)
          .attr('x', (d) => (xScale(d.data.xLabel) ?? 0) + barOffset)
          .attr('y', (d) => yCount(d[1]))
          .attr('width', barWidth)
          .attr('height', (d) => Math.max(0, yCount(d[0]) - yCount(d[1])))
          .attr('fill', bucketColors[colorKey])
          .attr('opacity', (d) => (d.data.isIncomplete ? 0.42 : 1))
          .attr('rx', isTop ? 6 : 0)
          .attr('ry', isTop ? 6 : 0);
      });
    } else {
      const barWidth = Math.min(xScale.bandwidth(), MAX_BAR_WIDTH);
      const barOffset = (xScale.bandwidth() - barWidth) / 2;

      root.selectAll('.count-bar')
        .data(visibleData)
        .join('rect')
        .attr('class', 'count-bar')
        .attr('x', (d) => (xScale(d.xLabel) ?? 0) + barOffset)
        .attr('y', (d) => yCount(d.count))
        .attr('width', barWidth)
        .attr('height', (d) => Math.max(0, mainInnerHeight - yCount(d.count)))
          .attr('fill', requestCountBarColor)
          .attr('opacity', (d) => (d.isIncomplete ? 0.42 : 1))
          .attr('rx', 6)
        .attr('ry', 6);
    }

    // Line
    const lineGen = d3.line()
      .defined((d) => Number.isFinite(Number(d[hoursKey])))
      .x((d) => (xScale(d.xLabel) ?? 0) + xScale.bandwidth() / 2)
      .y((d) => yHours(Number(d[hoursKey])))
      .curve(d3.curveMonotoneX);

    const linePath = root.append('path')
      .datum(visibleData)
      .attr('fill', 'none')
      .attr('stroke', lineColor)
      .attr('stroke-width', 2.5)
      .attr('stroke-dasharray', viewMode === 'unresolved' ? '6 4' : null)
      .attr('opacity', visibleData.some((d) => d.isIncomplete) ? 0.88 : 1)
      .attr('d', lineGen);

    if (!linePath.attr('d')) {
      linePath.remove();
    }

    // Line dots
    root.selectAll('.line-dot')
      .data(visibleData)
      .join('circle')
      .attr('class', 'line-dot')
      .attr('cx', (d) => (xScale(d.xLabel) ?? 0) + xScale.bandwidth() / 2)
      .attr('cy', (d) => yHours(Number(d[hoursKey])))
      .attr('r', (d) => (d[`${hoursKey}_anomaly`] ? 6 : 3))
      .attr('fill', (d) => (d[`${hoursKey}_anomaly`] ? colors.error : lineColor))
      .attr('stroke', (d) => (d[`${hoursKey}_anomaly`] ? dotStrokeColor : 'none'))
      .attr('stroke-width', (d) => (d[`${hoursKey}_anomaly`] ? 1.5 : 0))
      .attr('opacity', (d) => (d.isIncomplete ? 0.45 : 1))
      .attr('pointer-events', 'none');

    // Hover overlays
    const overlayGroup = root.append('g').attr('class', 'hover-layer');
    overlayGroup.selectAll('.hover-band')
      .data(visibleData)
      .join('rect')
      .attr('class', 'hover-band')
      .attr('x', (d) => xScale(d.xLabel) ?? 0)
      .attr('y', 0)
      .attr('width', xScale.bandwidth())
      .attr('height', mainInnerHeight)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mouseenter', function onEnter(event, d) {
        d3.select(this).attr('fill', alpha(requestCountBarColor, 0.08));
        const [mx, my] = d3.pointer(event, containerRef.current);
        setTooltip({ x: mx, y: my, data: d });
      })
      .on('mousemove', (event, d) => {
        const [mx, my] = d3.pointer(event, containerRef.current);
        setTooltip({ x: mx, y: my, data: d });
      })
      .on('mouseleave', function onLeave() {
        d3.select(this).attr('fill', 'transparent');
        setTooltip(null);
      });

    // Brush overview
    if (brushEnabled && chartData.length > 1) {
      const brushTop = mainInnerHeight + brushGap;
      const brushInnerWidth = innerWidth;
      const brushScale = d3.scaleBand()
        .domain(d3.range(chartData.length))
        .range([0, brushInnerWidth])
        .padding(0.12);

      const brushMax = d3.max(chartData, (d) => Number(d.count) || 0) || 1;
      const brushY = d3.scaleLinear()
        .domain([0, brushMax])
        .range([BRUSH_HEIGHT, 0]);

      const brushPlot = root.append('g')
        .attr('class', 'brush-plot')
        .attr('transform', `translate(0,${brushTop})`);

      brushPlot.selectAll('.brush-bar')
        .data(chartData)
        .join('rect')
        .attr('class', 'brush-bar')
        .attr('x', (_, i) => brushScale(String(i)) ?? 0)
        .attr('y', (d) => brushY(d.count))
        .attr('width', brushScale.bandwidth())
        .attr('height', (d) => BRUSH_HEIGHT - brushY(d.count))
        .attr('fill', alpha(requestCountBarColor, 0.35))
        .attr('pointer-events', 'none');

      const brush = d3.brushX()
        .extent([[0, 0], [brushInnerWidth, BRUSH_HEIGHT]])
        .on('end', (event) => {
          if (!event.selection) {
            const [start, end] = defaultBrushRange(chartData.length);
            handleBrushRangeChange(start, end);
            const sel = brushSelectionPixels(start, end, brushScale);
            brushPlot.select('.brush').call(brush.move, sel);
            return;
          }

          const [x0, x1] = event.selection;
          const start = brushIndexFromX(x0, brushScale, chartData.length);
          const end = brushIndexFromX(x1, brushScale, chartData.length);
          handleBrushRangeChange(Math.min(start, end), Math.max(start, end));
        });

      function brushSelectionPixels(start, end, scale) {
        const x0 = scale(String(start)) ?? 0;
        const x1 = (scale(String(end)) ?? 0) + scale.bandwidth();
        return [x0, x1];
      }

      const brushG = brushPlot.append('g')
        .attr('class', 'brush')
        .call(brush);

      brushG.selectAll('.selection')
        .attr('fill', alpha(requestCountBarColor, 0.08))
        .attr('stroke', alpha(requestCountBarColor, 0.45));

      brushG.selectAll('.handle')
        .attr('width', 8)
        .attr('fill', alpha(requestCountBarColor, 0.25));

      const [start, end] = brushRangeRef.current;
      const safeStart = Math.max(0, Math.min(start, chartData.length - 1));
      const safeEnd = Math.max(safeStart, Math.min(end, chartData.length - 1));
      brushG.call(brush.move, brushSelectionPixels(safeStart, safeEnd, brushScale));
    }

    return undefined;
  }, [
    visibleData,
    chartData,
    dimensions,
    legendHeight,
    brushEnabled,
    compactFooter,
    useStackedBars,
    hoursKey,
    hoursDomainMax,
    lineColor,
    viewMode,
    colors,
    semantic,
    bucketColors,
    requestCountBarColor,
    dotStrokeColor,
    legendItems,
    handleBrushRangeChange,
  ]);

  return (
    <GlassChartCard accent="dashboard">
      <VizSectionHeader
        icon={TimelineIcon}
        iconColor={colors.warning}
        title={title}
        subtitle={activeSubtitle}
        tooltip="Switch between resolved and unresolved views. Resolved shows actual response times; unresolved shows model-predicted delays for open requests."
        actions={(
          <ToggleButtonGroup
            exclusive
            size="small"
            value={viewMode}
            onChange={(_, value) => value && setViewMode(value)}
            sx={{
              '& .MuiToggleButton-root': {
                px: 1.25,
                py: 0.25,
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'none',
                color: colors.textSecondary,
                borderColor: colors.border,
                '&.Mui-selected': {
                  color: colors.textPrimary,
                  bgcolor: alpha(colors.primary, 0.08),
                },
              },
            }}
          >
            <ToggleButton value="resolved">Resolved</ToggleButton>
            <ToggleButton value="unresolved">Unresolved</ToggleButton>
          </ToggleButtonGroup>
        )}
      />

      <Box
        ref={containerRef}
        sx={{
          width: '100%',
          height: chartHeight,
          minHeight: chartHeight,
          minWidth: 0,
          mt: 0.5,
          flexShrink: 0,
          position: 'relative',
        }}
      >
        {chartData.length === 0 ? (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 2,
              border: `1px dashed ${colors.border}`,
              color: colors.chartLabel,
            }}
          >
            <Typography variant="body2">No timeline data for the current filters.</Typography>
          </Box>
        ) : (
          <>
            <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            {tooltip && (
              <ChartTooltip
                x={tooltip.x}
                y={tooltip.y}
                containerWidth={dimensions.width}
                containerHeight={dimensions.height}
                title={tooltip.data.xLabel}
                rows={buildTooltipRows(tooltip.data, viewMode, bucketColors, useStackedBars)}
                neutral={!useStackedBars}
              />
            )}
          </>
        )}
      </Box>

      {chartData.length > 0 && (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', mt: 0.75, alignItems: 'center' }}>
          <Typography variant="caption" sx={{ color: colors.textSecondary, mr: 0.25 }}>
            Delay bands:
          </Typography>
          {HOURS_BANDS.map(({ label, colorKey, opacity }) => (
            <Stack key={label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 12,
                  height: 8,
                  borderRadius: 0.5,
                  bgcolor: alpha(bucketColors[colorKey], Math.min(opacity * 2.2, 0.35)),
                  border: `1px solid ${alpha(bucketColors[colorKey], 0.25)}`,
                }}
              />
              <Typography variant="caption" sx={{ color: colors.chartLabel }}>
                {label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}

      {viewMode === 'resolved' && chartData.length > 0 && (
        <Typography variant="caption" sx={{ color: colors.textSecondary, mt: 0.75, display: 'block', lineHeight: 1.45 }}>
          Recent months may understate average response time because slower requests are still open and excluded from resolved averages. Lighter bars mark the most recent incomplete months.
        </Typography>
      )}

      {hasLineAnomalies && (
        <Typography variant="caption" sx={{ color: colors.textSecondary, mt: 0.75, display: 'block' }}>
          Anomalous months (±2sigma from mean)
        </Typography>
      )}

      {!compactFooter && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', mt: 1.5 }}>
          {(useStackedBars
            ? [
              ...STACK_BUCKETS.map(({ name, colorKey }) => ({
                label: name,
                swatch: bucketColors[colorKey],
              })),
              viewMode === 'resolved'
                ? { label: 'Avg response (actual)', swatch: lineColors.response }
                : { label: 'Avg predicted', swatch: lineColors.predicted },
            ]
            : [
              { label: 'Request count', swatch: requestCountBarColor },
              viewMode === 'resolved'
                ? { label: 'Avg response (actual)', swatch: lineColors.response }
                : { label: 'Avg predicted', swatch: lineColors.predicted },
            ]
          ).map((item, index) => (
            <Stack key={`${item.label}-${index}`} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: item.swatch, boxShadow: `0 0 8px ${alpha(item.swatch, 0.45)}` }} />
              <Typography variant="caption" sx={{ color: colors.chartLabel }}>
                {item.label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </GlassChartCard>
  );
}
