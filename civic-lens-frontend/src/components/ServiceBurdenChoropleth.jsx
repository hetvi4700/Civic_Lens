import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  Typography,
  Box,
  Chip,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  alpha,
} from '@mui/material';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { getChartPlotBox, getSelectedFilterChipSx } from '../theme';
import ChartTooltip from './ChartTooltip';
import { useAppColors, useColorMode } from '../ColorModeContext';
import { formatHours } from '../utils/analytics';
import GlassChartCard from './GlassChartCard';
import VizSectionHeader from './VizSectionHeader';
import boroughGeoRaw from '../data/nyc-boroughs.geojson?raw';
import {
  ALL_BOROUGHS,
  getBoroughColor,
  getBoroughLegendShort,
  getBoroughShade,
  getBoroughStrokeColor,
  getDashboardSemanticColors,
  getMetricFillOpacity,
  normalizeBoroughName,
} from '../styles/dashboardColors';

const boroughGeoJson = JSON.parse(boroughGeoRaw);

const METRICS = [
  { key: 'burdenScore', label: 'Burden Score', format: (v) => Number(v).toFixed(2) },
  { key: 'avgResponseHours', label: 'Avg Response Time', format: (v) => formatHours(v) },
  { key: 'unresolvedRate', label: 'Unresolved Rate', format: (v) => `${(Number(v) * 100).toFixed(1)}%` },
  { key: 'count', label: 'Request Volume', format: (v) => Number(v).toLocaleString() },
];

const DEFAULT_STAT = (borough) => ({
  borough,
  hasData: false,
  count: null,
  avgResponseHours: null,
  unresolvedRate: null,
  highDelayCount: null,
  highDelayRate: null,
  burdenScore: null,
});

function mergeBoroughStats(boroughStats) {
  const lookup = {};
  (boroughStats || []).forEach((entry) => {
    const borough = normalizeBoroughName(entry.borough);
    if (!ALL_BOROUGHS.includes(borough)) return;
    lookup[borough] = { ...entry, borough, hasData: true };
  });
  return ALL_BOROUGHS.map((borough) => lookup[borough] ?? DEFAULT_STAT(borough));
}

function getMetricValue(entry, metricKey) {
  if (!entry?.hasData) return null;
  const value = Number(entry?.[metricKey]);
  return Number.isFinite(value) ? value : null;
}

function formatMetricLabel(entry, metricKey, formatFn) {
  const value = getMetricValue(entry, metricKey);
  return value == null ? '—' : formatFn(value);
}

function getMetricMeta(metricKey) {
  return METRICS.find((metric) => metric.key === metricKey) || METRICS[0];
}

function shortBoroughName(name) {
  return name === 'Staten Island' ? 'Staten Is.' : name;
}

function getMetricDomain(metricKey, stats) {
  const values = stats
    .filter((entry) => entry.hasData)
    .map((entry) => getMetricValue(entry, metricKey))
    .filter((value) => value != null);
  const [minValue, maxValue] = d3.extent(values);
  return {
    domainMin: minValue ?? 0,
    domainMax: maxValue === minValue ? (minValue ?? 0) + 1 : maxValue ?? 1,
  };
}

function getBoroughFromFeature(feature) {
  const raw = feature?.properties?.borough || feature?.properties?.name || 'Unknown';
  return normalizeBoroughName(raw);
}

const WATER_RIVERS = [
  {
    name: 'Hudson River',
    coordinates: [[-74.048, 40.915], [-74.042, 40.84], [-74.034, 40.76], [-74.026, 40.68], [-74.02, 40.60]],
  },
  {
    name: 'East River',
    coordinates: [[-73.975, 40.88], [-73.968, 40.82], [-73.962, 40.76], [-73.956, 40.72], [-73.952, 40.70]],
  },
];

const WATER_BAYS = [
  {
    name: 'Upper Bay',
    coordinates: [[
      [-74.07, 40.645],
      [-73.88, 40.645],
      [-73.84, 40.56],
      [-74.03, 40.56],
      [-74.07, 40.645],
    ]],
  },
];

const MAP_CONTEXT_LABELS = [
  { text: 'Hudson River', lng: -74.038, lat: 40.8, rotate: -82 },
  { text: 'East River', lng: -73.964, lat: 40.77, rotate: -78 },
  { text: 'Upper Bay', lng: -73.98, lat: 40.6, rotate: -8 },
  { text: 'NYC Boroughs', lng: -73.74, lat: 40.905, rotate: 0, emphasis: true },
];

function appendMapBackgroundDefs(defs, semantic) {
  const gridStroke = semantic.grid;
  const diagStroke = semantic.gridDiag;

  const gridPattern = defs
    .append('pattern')
    .attr('id', 'boro-choro-grid')
    .attr('width', 28)
    .attr('height', 28)
    .attr('patternUnits', 'userSpaceOnUse');

  gridPattern
    .append('rect')
    .attr('width', 28)
    .attr('height', 28)
    .attr('fill', 'transparent');

  gridPattern
    .append('path')
    .attr('d', 'M 28 0 L 0 0 0 28')
    .attr('fill', 'none')
    .attr('stroke', gridStroke)
    .attr('stroke-width', 0.65);

  const diagPattern = defs
    .append('pattern')
    .attr('id', 'boro-choro-diag')
    .attr('width', 56)
    .attr('height', 56)
    .attr('patternUnits', 'userSpaceOnUse')
    .attr('patternTransform', 'rotate(35)');

  diagPattern
    .append('line')
    .attr('x1', 0)
    .attr('y1', 0)
    .attr('x2', 0)
    .attr('y2', 56)
    .attr('stroke', diagStroke)
    .attr('stroke-width', 0.8);

  const shadowFilter = defs
    .append('filter')
    .attr('id', 'boro-choro-shadow')
    .attr('x', '-18%')
    .attr('y', '-18%')
    .attr('width', '136%')
    .attr('height', '136%');

  shadowFilter
    .append('feDropShadow')
    .attr('dx', 0)
    .attr('dy', 1.6)
    .attr('stdDeviation', 2.2)
    .attr('flood-color', semantic.shadowFloodColor)
    .attr('flood-opacity', semantic.shadowFloodOpacity);
}

function renderMapPanelBackground(layer, { innerWidth, innerHeight, semantic }) {
  const panelFill = semantic.mapPanelBg;
  const panelStroke = semantic.mapPanelBorder;

  layer
    .append('rect')
    .attr('class', 'map-panel-bg')
    .attr('width', innerWidth)
    .attr('height', innerHeight)
    .attr('rx', 18)
    .attr('fill', panelFill)
    .attr('stroke', panelStroke)
    .attr('stroke-width', 1);

  layer
    .append('rect')
    .attr('class', 'map-grid')
    .attr('width', innerWidth)
    .attr('height', innerHeight)
    .attr('rx', 18)
    .attr('fill', 'url(#boro-choro-grid)')
    .attr('pointer-events', 'none');

  layer
    .append('rect')
    .attr('class', 'map-diag')
    .attr('width', innerWidth)
    .attr('height', innerHeight)
    .attr('rx', 18)
    .attr('fill', 'url(#boro-choro-diag)')
    .attr('pointer-events', 'none');
}

function renderMapGeographicContext(layer, { path, projection, semantic }) {
  const waterFill = semantic.waterFill;
  const waterStroke = semantic.waterStroke;
  const labelFill = alpha(semantic.muted, 0.62);
  const labelEmphasis = alpha(semantic.muted, 0.88);

  const waterLayer = layer.append('g').attr('class', 'water-layer').attr('pointer-events', 'none');

  WATER_BAYS.forEach((bay) => {
    const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: bay.coordinates } };
    waterLayer
      .append('path')
      .attr('d', path(feature))
      .attr('fill', waterFill)
      .attr('stroke', waterStroke)
      .attr('stroke-width', 0.8);
  });

  WATER_RIVERS.forEach((river) => {
    const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: river.coordinates } };
    waterLayer
      .append('path')
      .attr('d', path(feature))
      .attr('fill', 'none')
      .attr('stroke', waterStroke)
      .attr('stroke-width', 10)
      .attr('stroke-linecap', 'round')
      .attr('opacity', 0.55);
  });

  const labelLayer = layer.append('g').attr('class', 'context-labels').attr('pointer-events', 'none');

  MAP_CONTEXT_LABELS.forEach((label) => {
    const point = projection([label.lng, label.lat]);
    if (!point) return;
    const [x, y] = point;

    labelLayer
      .append('text')
      .attr('x', x)
      .attr('y', y)
      .attr('text-anchor', 'middle')
      .attr('fill', label.emphasis ? labelEmphasis : labelFill)
      .attr('font-size', label.emphasis ? 10 : 9)
      .attr('font-weight', label.emphasis ? 600 : 500)
      .attr('letter-spacing', label.emphasis ? '0.04em' : '0.02em')
      .attr('transform', label.rotate ? `rotate(${label.rotate}, ${x}, ${y})` : null)
      .text(label.text);
  });
}

export default function ServiceBurdenChoropleth({
  boroughStats = [],
  selectedBorough = null,
  onSelectBorough,
  metric: metricProp,
  onMetricChange,
  title = 'Borough Burden Overview',
  subtitle = 'Compares boroughs using request volume, response delay, unresolved rate, and high-delay share.',
  plotHeight = 560,
  compactFooter = false,
  densePlot = false,
}) {
  const colors = useAppColors();
  const { mode } = useColorMode();
  const chartPlotBox = useMemo(() => getChartPlotBox(colors, mode), [colors, mode]);
  const selectedFilterChipSx = useMemo(() => getSelectedFilterChipSx(colors), [colors]);
  const semantic = useMemo(() => getDashboardSemanticColors(colors, mode), [colors, mode]);

  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [internalMetric, setInternalMetric] = useState('burdenScore');
  const [dimensions, setDimensions] = useState({ width: 800, height: plotHeight });
  const [geoReady, setGeoReady] = useState(Boolean(boroughGeoJson?.features?.length));

  const metric = metricProp ?? internalMetric;
  const stats = useMemo(() => mergeBoroughStats(boroughStats), [boroughStats]);
  const statsByBorough = useMemo(
    () => Object.fromEntries(stats.map((entry) => [entry.borough, entry])),
    [stats],
  );
  const metricMeta = getMetricMeta(metric);

  const geoFeatures = useMemo(() => {
    if (!boroughGeoJson?.features?.length) return [];
    return boroughGeoJson.features.map((feature) => ({
      ...feature,
      borough: getBoroughFromFeature(feature),
      stats: statsByBorough[getBoroughFromFeature(feature)] || DEFAULT_STAT(getBoroughFromFeature(feature)),
    }));
  }, [statsByBorough]);

  const handleMetricChange = (event) => {
    const next = event.target.value;
    if (onMetricChange) onMetricChange(next);
    else setInternalMetric(next);
  };

  useEffect(() => {
    setGeoReady(Boolean(boroughGeoJson?.features?.length));
  }, []);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDimensions({ width, height });
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!svgRef.current || !geoReady || !geoFeatures.length) return;

    const { width, height } = dimensions;
    if (width <= 0 || height <= 0) return;
    const padding = { top: 8, right: 12, bottom: 52, left: 12 };
    const innerWidth = Math.max(width - padding.left - padding.right, 100);
    const innerHeight = Math.max(height - padding.top - padding.bottom, 100);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', 'NYC borough service burden choropleth');

    const defs = svg.append('defs');
    appendMapBackgroundDefs(defs, semantic);

    const glowFilter = defs.append('filter').attr('id', 'borough-choro-glow');
    glowFilter.attr('x', '-30%').attr('y', '-30%').attr('width', '160%').attr('height', '160%');
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '1.8').attr('result', 'blur');
    const glowMerge = glowFilter.append('feMerge');
    glowMerge.append('feMergeNode').attr('in', 'blur');
    glowMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    defs
      .append('clipPath')
      .attr('id', 'boro-choro-clip')
      .append('rect')
      .attr('width', innerWidth)
      .attr('height', innerHeight)
      .attr('rx', 18);

    const root = svg.append('g').attr('transform', `translate(${padding.left},${padding.top})`);

    const projection = d3.geoMercator();
    const path = d3.geoPath().projection(projection);
    const mapInsetX = 10;
    const mapInsetY = 6;
    const mapWidth = innerWidth - mapInsetX * 2;
    const mapHeight = innerHeight - mapInsetY * 2 - 8;
    projection.fitSize([mapWidth, mapHeight], boroughGeoJson);

    const { domainMin, domainMax } = getMetricDomain(metric, stats);
    const hoverStrokeColor = (borough) => getBoroughColor(borough, mode);
    const labelFill = semantic.title;
    const metricLabelFill = semantic.muted;

    const mapLayer = root
      .append('g')
      .attr('class', 'map-layer')
      .attr('clip-path', 'url(#boro-choro-clip)');

    renderMapPanelBackground(mapLayer, { innerWidth, innerHeight, semantic });

    const boroughCanvas = mapLayer
      .append('g')
      .attr('class', 'borough-canvas')
      .attr('transform', `translate(${mapInsetX},${mapInsetY})`);

    renderMapGeographicContext(boroughCanvas, { path, projection, semantic });

    boroughCanvas
      .selectAll('.borough-shadow')
      .data(geoFeatures, (d) => d.borough)
      .join('path')
      .attr('class', 'borough-shadow')
      .attr('d', (d) => path(d))
      .attr('fill', mode === 'light' ? alpha('#0f172a', 0.12) : alpha('#000000', 0.22))
      .attr('stroke', 'none')
      .attr('filter', 'url(#boro-choro-shadow)')
      .attr('pointer-events', 'none');

    const boroughGroups = boroughCanvas
      .selectAll('.borough-group')
      .data(geoFeatures, (d) => d.borough)
      .join('g')
      .attr('class', 'borough-group')
      .style('cursor', 'pointer');

    boroughGroups
      .append('path')
      .attr('class', 'borough-shape')
      .attr('d', (d) => path(d))
      .attr('fill', (d) => (
        d.stats?.hasData
          ? getBoroughShade(d.borough, mode, 'map')
          : alpha(semantic.muted, mode === 'light' ? 0.18 : 0.24)
      ))
      .attr('fill-opacity', (d) => {
        if (!d.stats?.hasData) return 0.55;
        return getMetricFillOpacity(
          getMetricValue(d.stats, metric),
          domainMin,
          domainMax,
        );
      })
      .attr('stroke', (d) => (
        selectedBorough === d.borough
          ? hoverStrokeColor(d.borough)
          : getBoroughStrokeColor(d.borough, mode)
      ))
      .attr('stroke-width', (d) => (selectedBorough === d.borough ? 3 : 1.45))
      .attr('opacity', (d) => (selectedBorough && selectedBorough !== d.borough ? 0.42 : 0.94))
      .attr('filter', (d) => (selectedBorough === d.borough ? 'url(#borough-choro-glow)' : null))
      .on('mouseenter', function onEnter(event, d) {
        d3.select(this)
          .attr('opacity', 1)
          .attr('stroke', hoverStrokeColor(d.borough))
          .attr('stroke-width', selectedBorough === d.borough ? 3 : 2);
        setTooltip({ x: event.offsetX, y: event.offsetY, data: d.stats });
      })
      .on('mousemove', (event) => {
        setTooltip((prev) => (prev ? { ...prev, x: event.offsetX, y: event.offsetY } : prev));
      })
      .on('mouseleave', function onLeave(_, d) {
        d3.select(this)
          .attr('opacity', selectedBorough && selectedBorough !== d.borough ? 0.42 : 0.94)
          .attr('stroke', selectedBorough === d.borough
            ? hoverStrokeColor(d.borough)
            : getBoroughStrokeColor(d.borough, mode))
          .attr('stroke-width', selectedBorough === d.borough ? 3 : 1.45);
        setTooltip(null);
      })
      .on('click', (_, d) => {
        onSelectBorough?.(d.borough === selectedBorough ? null : d.borough);
      });

    boroughGroups.each(function addLabels(d) {
      const group = d3.select(this);
      const [cx, cy] = path.centroid(d);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

      group
        .append('circle')
        .attr('class', 'borough-dot')
        .attr('cx', cx)
        .attr('cy', cy - 14)
        .attr('r', 3.5)
        .attr('fill', getBoroughColor(d.borough, mode))
        .attr('pointer-events', 'none');

      group
        .append('text')
        .attr('class', 'borough-label')
        .attr('x', cx)
        .attr('y', cy - 4)
        .attr('text-anchor', 'middle')
        .attr('fill', labelFill)
        .attr('font-size', 13)
        .attr('font-weight', 700)
        .attr('pointer-events', 'none')
        .text(shortBoroughName(d.borough));

      group
        .append('text')
        .attr('class', 'borough-metric')
        .attr('x', cx)
        .attr('y', cy + 10)
        .attr('text-anchor', 'middle')
        .attr('fill', metricLabelFill)
        .attr('font-size', 10)
        .attr('pointer-events', 'none')
        .text(formatMetricLabel(d.stats, metric, metricMeta.format));
    });

    const legend = root.append('g').attr('transform', `translate(10, ${innerHeight - 54})`);

    legend
      .append('text')
      .attr('y', 0)
      .attr('fill', metricLabelFill)
      .attr('font-size', 9)
      .attr('font-weight', 600)
      .text('Borough colors');

    ALL_BOROUGHS.forEach((borough, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = col * 68;
      const y = 8 + row * 13;

      legend
        .append('rect')
        .attr('x', x)
        .attr('y', y)
        .attr('width', 7)
        .attr('height', 7)
        .attr('rx', 1.5)
        .attr('fill', getBoroughColor(borough, mode))
        .attr('fill-opacity', 0.78);

      legend
        .append('text')
        .attr('x', x + 10)
        .attr('y', y + 6)
        .attr('fill', labelFill)
        .attr('font-size', 8)
        .text(getBoroughLegendShort(borough));
    });

    legend
      .append('text')
      .attr('y', 38)
      .attr('fill', metricLabelFill)
      .attr('font-size', 9)
      .text(`Darker fill = higher ${metricMeta.label.toLowerCase()}`);
  }, [
    geoReady,
    geoFeatures,
    stats,
    selectedBorough,
    metric,
    dimensions,
    metricMeta,
    onSelectBorough,
    colors,
    mode,
    semantic,
  ]);

  return (
    <GlassChartCard
      selected={Boolean(selectedBorough)}
      accent="dashboard"
      contentSx={densePlot ? { p: '18px 20px' } : undefined}
    >
      <VizSectionHeader
        icon={MapOutlinedIcon}
        iconColor={colors.warning}
        title={title}
        subtitle={subtitle}
        tooltip="Aggregated borough burden from filtered 311 data. Click a borough to filter the dashboard."
        selected={Boolean(selectedBorough)}
        compact={densePlot}
        actions={(
          <>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel id="choro-metric-label">Metric</InputLabel>
              <Select
                labelId="choro-metric-label"
                value={metric}
                label="Metric"
                onChange={handleMetricChange}
              >
                {METRICS.map(({ key, label }) => (
                  <MenuItem key={key} value={key}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {selectedBorough && (
              <Chip
                label={selectedBorough}
                size="small"
                onDelete={() => onSelectBorough?.(null)}
                sx={selectedFilterChipSx}
              />
            )}
          </>
        )}
      />

      <Box
        ref={containerRef}
        sx={{
          ...chartPlotBox,
          borderRadius: densePlot ? '12px' : '18px',
          ...(densePlot
            ? { border: 'none', bgcolor: 'transparent' }
            : {
              border: `1px solid ${semantic.mapPanelBorder}`,
              bgcolor: semantic.mapPanelBg,
            }),
          height: plotHeight,
          mt: densePlot ? 0 : 0.5,
          flex: 1,
          minHeight: plotHeight,
          overflow: 'hidden',
        }}
      >
        {!geoReady ? (
          <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography variant="body2" sx={{ color: colors.textSecondary, fontSize: '0.8125rem' }}>
              NYC borough geometry could not be loaded.
            </Typography>
          </Box>
        ) : (
          <>
            <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />
            {tooltip && (() => {
              return (
                <ChartTooltip
                  x={tooltip.x}
                  y={tooltip.y}
                  containerWidth={dimensions.width}
                  containerHeight={dimensions.height}
                  title={tooltip.data.borough}
                  rows={tooltip.data.hasData ? [
                    { label: 'Requests', value: tooltip.data.count.toLocaleString() },
                    { label: 'Avg response', value: formatHours(tooltip.data.avgResponseHours) },
                    { label: 'Unresolved rate', value: `${(tooltip.data.unresolvedRate * 100).toFixed(1)}%` },
                    {
                      label: 'High delay',
                      value: `${Number(tooltip.data.highDelayCount ?? 0).toLocaleString()} (${((tooltip.data.highDelayRate ?? 0) * 100).toFixed(1)}%)`,
                    },
                    { label: 'Burden score', value: tooltip.data.burdenScore.toFixed(2) },
                  ] : [
                    { label: 'Status', value: 'No data for current filters' },
                  ]}
                />
              );
            })()}
          </>
        )}
      </Box>

      {!compactFooter && geoReady && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: colors.textSecondary, fontFamily: 'inherit' }}>
          Click a borough to filter · Hover for borough KPIs
        </Typography>
      )}
    </GlassChartCard>
  );
}
