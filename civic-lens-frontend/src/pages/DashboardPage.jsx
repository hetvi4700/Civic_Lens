import { useMemo, useCallback, useRef, useEffect } from 'react';
import { Box } from '@mui/material';
import PageIntro from '../components/PageIntro';
import PageLoadingBar from '../components/PageLoadingBar';
import DashboardCompactFilters from '../components/DashboardCompactFilters';
import DashboardKpis from '../components/DashboardKpis';
import DashboardSectionHeading from '../components/DashboardSectionHeading';
import ServiceBurdenChoropleth from '../components/ServiceBurdenChoropleth';
import SelectedAreaInsightPanel from '../components/SelectedAreaInsightPanel';
import ComplaintTypeRanking from '../components/ComplaintTypeRanking';
import DelayTimeline from '../components/DelayTimeline';
import ChartLoadingOverlay from '../components/ChartLoadingOverlay';
import { DataEmptyState, DataErrorState } from '../components/DataFetchStatus';
import { useFilters } from '../context/FilterContext';
import { useAppSnackbar, useSnackbarLoadSync } from '../context/AppSnackbarContext';
import useCascadingFacets from '../hooks/useCascadingFacets';
import useDashboardData from '../hooks/useDashboardData';
import useMinimumLoading from '../hooks/useMinimumLoading';
import useFilterTransitionLoading from '../hooks/useFilterTransitionLoading';
import { buildAreaSummary, buildDelayDrivers } from '../utils/areaInsight';
import {
  PAGE_GRID_GAP,
  DASHBOARD_PLOT_HEIGHT_ROW1,
  DASHBOARD_PLOT_HEIGHT_ROW2,
} from '../styles/dashboardLayout';

const DASHBOARD_SECTION_GAP = '22px';
const DASHBOARD_BLOCK_GAP = '28px';

const GRID_12 = {
  display: 'grid',
  gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
  gap: PAGE_GRID_GAP,
  alignItems: 'stretch',
};

function hasDashboardData(data) {
  return Boolean(data?.stats);
}

function ChartSkeletonSlot({ height }) {
  return (
    <ChartLoadingOverlay loading>
      <Box sx={{ width: '100%', minHeight: height }} />
    </ChartLoadingOverlay>
  );
}

export default function DashboardPage() {
  const { filters, handleFilterChange, resetFilters } = useFilters();
  const { beginUserLoad } = useAppSnackbar();
  const { facets, facetsReady, facetsLoading } = useCascadingFacets(filters);
  const { data, loading, isRefreshing, error, refetch } = useDashboardData(filters, {
    enabled: facetsReady,
  });

  const hasEverLoadedRef = useRef(hasDashboardData(data));

  useEffect(() => {
    if (hasDashboardData(data)) {
      hasEverLoadedRef.current = true;
    }
  }, [data]);

  const filtersKey = JSON.stringify(filters);

  const dataReady = facetsReady && !loading && !isRefreshing;
  const hasData = hasDashboardData(data);

  const {
    beginTransition,
    filterTransitionActive,
    visibleFilterTransitioning,
  } = useFilterTransitionLoading({
    filterKey: filtersKey,
    hasEverLoadedRef,
    facetsReady,
    facetsLoading,
    loading,
    isRefreshing,
  });

  useSnackbarLoadSync({
    loading: loading || isRefreshing || facetsLoading || filterTransitionActive,
    error,
    queryKey: filtersKey,
  });

  const onFilterChange = useCallback((key, value) => {
    beginUserLoad();
    beginTransition();
    handleFilterChange(key, value);
  }, [beginUserLoad, beginTransition, handleFilterChange]);

  const onResetFilters = useCallback(() => {
    beginUserLoad();
    beginTransition();
    resetFilters();
  }, [beginUserLoad, beginTransition, resetFilters]);

  const onRetry = useCallback(() => {
    beginUserLoad();
    beginTransition();
    refetch();
  }, [beginUserLoad, beginTransition, refetch]);

  const rawInitialLoading = !hasEverLoadedRef.current && (
    facetsLoading
    || !facetsReady
    || loading
    || isRefreshing
    || (!hasData && facetsReady && !error)
  );
  const rawRefreshing = hasData && (isRefreshing || loading);

  const visibleInitialLoading = useMinimumLoading(rawInitialLoading);
  const visibleRefreshing = useMinimumLoading(rawRefreshing);
  const showFilterLoading = visibleFilterTransitioning || visibleRefreshing;
  const showLoadingState = visibleInitialLoading || showFilterLoading;

  const selectedBorough = filters.borough !== 'All' ? filters.borough : null;
  const selectedComplaint = filters.complaint_type !== 'All' ? filters.complaint_type : null;

  const handleBoroughSelect = useCallback((borough) => {
    beginUserLoad();
    beginTransition();
    handleFilterChange('borough', borough || 'All');
  }, [beginUserLoad, beginTransition, handleFilterChange]);

  const handleComplaintSelect = useCallback((complaint) => {
    beginUserLoad();
    beginTransition();
    handleFilterChange('complaint_type', complaint || 'All');
  }, [beginUserLoad, beginTransition, handleFilterChange]);

  const isEmpty = dataReady && hasData && data.stats.totalRequests === 0;

  const boroughStats = hasData ? (data.boroughBurden?.boroughs ?? []) : [];
  const complaintStats = hasData ? (data.complaintDrivers?.complaints ?? []) : [];
  const timelineData = hasData ? (data.delayTrend?.timeline ?? []) : [];
  const statsData = hasData ? data.stats : null;

  const areaSummary = useMemo(
    () => (statsData
      ? buildAreaSummary(filters, boroughStats, complaintStats, statsData)
      : null),
    [statsData, filters, boroughStats, complaintStats],
  );

  const delayDrivers = useMemo(
    () => (statsData
      ? buildDelayDrivers(complaintStats, timelineData[0]?.year ?? null)
      : []),
    [statsData, complaintStats, timelineData],
  );

  if (!showLoadingState && error && !hasData) {
    return <DataErrorState error={error} onRetry={onRetry} />;
  }

  if (!showLoadingState && isEmpty) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: DASHBOARD_BLOCK_GAP }}>
        <PageIntro
          page="dashboard"
          eyebrow="Citywide Analytics"
          title="Service Dashboard"
          description="Explore where service burden is highest, why selected areas stand out, which complaints drive delay and backlog, and how volume and response times change over time."
        />
        <DashboardCompactFilters
          facets={facets}
          filters={filters}
          onFilterChange={onFilterChange}
          onReset={onResetFilters}
        />
        <DataEmptyState message="No requests match the current filters." />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: DASHBOARD_BLOCK_GAP,
      }}
    >
      <PageIntro
        page="dashboard"
        eyebrow="Citywide Analytics"
        title="Service Dashboard"
        description="Explore where service burden is highest, why selected areas stand out, which complaints drive delay and backlog, and how volume and response times change over time."
      />

      <DashboardCompactFilters
        facets={facets}
        filters={filters}
        onFilterChange={onFilterChange}
        onReset={onResetFilters}
      />

      <PageLoadingBar loading={showLoadingState} page="dashboard" />

      {showLoadingState ? (
        <>
          <DashboardKpis loading />

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: DASHBOARD_SECTION_GAP }}>
            <DashboardSectionHeading
              title="Where is service burden highest?"
              subtitle="Start with geography — identify boroughs with heavier volume, slower response, and unresolved cases."
            />
            <Box sx={GRID_12}>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 8' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ChartSkeletonSlot height={DASHBOARD_PLOT_HEIGHT_ROW1} />
              </Box>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 4' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ChartSkeletonSlot height={DASHBOARD_PLOT_HEIGHT_ROW1} />
              </Box>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: DASHBOARD_SECTION_GAP }}>
            <DashboardSectionHeading
              title="What issues drive delay and backlog?"
              subtitle="Rank complaint types by volume, response time, and unresolved rate."
            />
            <Box sx={GRID_12}>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 6' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ChartSkeletonSlot height={DASHBOARD_PLOT_HEIGHT_ROW2} />
              </Box>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 6' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ChartSkeletonSlot height={DASHBOARD_PLOT_HEIGHT_ROW2} />
              </Box>
            </Box>
          </Box>
        </>
      ) : (
        <>
          <DashboardKpis kpis={statsData} />

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: DASHBOARD_SECTION_GAP }}>
            <DashboardSectionHeading
              title="Where is service burden highest?"
              subtitle="Start with geography — identify boroughs with heavier volume, slower response, and unresolved cases."
            />

            <Box sx={GRID_12}>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 8' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ServiceBurdenChoropleth
                  boroughStats={boroughStats}
                  selectedBorough={selectedBorough}
                  onSelectBorough={handleBoroughSelect}
                  title="Borough Burden Overview"
                  subtitle="Compares boroughs using request volume, response delay, unresolved rate, and high-delay share."
                  plotHeight={DASHBOARD_PLOT_HEIGHT_ROW1}
                  compactFooter
                  densePlot
                />
              </Box>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 4' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <SelectedAreaInsightPanel summary={areaSummary} drivers={delayDrivers} />
              </Box>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: DASHBOARD_SECTION_GAP }}>
            <DashboardSectionHeading
              title="What issues drive delay and backlog?"
              subtitle="Rank complaint types by volume, response time, and unresolved rate."
            />

            <Box sx={GRID_12}>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 6' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <ComplaintTypeRanking
                  complaintStats={complaintStats}
                  selectedBorough={selectedBorough}
                  selectedComplaint={selectedComplaint}
                  onSelectComplaint={handleComplaintSelect}
                  title="Top Complaint Drivers"
                  subtitle="Ranks complaint types by request volume, delay, and unresolved rate."
                  plotHeight={DASHBOARD_PLOT_HEIGHT_ROW2}
                  compactFooter
                  maxItems={8}
                />
              </Box>
              <Box sx={{ gridColumn: { xs: '1 / -1', lg: 'span 6' }, minWidth: 0, minHeight: 0, display: 'flex' }}>
                <DelayTimeline
                  timelineData={timelineData}
                  selectedBorough={selectedBorough}
                  title="Delay Trend Over Time"
                  subtitle="Shows how request volume, actual response time, predicted response time, and unresolved rate change by month."
                  plotHeight={DASHBOARD_PLOT_HEIGHT_ROW2}
                  compactFooter
                />
              </Box>
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
}
