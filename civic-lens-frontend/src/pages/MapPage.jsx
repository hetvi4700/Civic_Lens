import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { Box } from '@mui/material';
import PageIntro from '../components/PageIntro';
import PageLoadingBar from '../components/PageLoadingBar';
import MapControlPanel from '../components/MapControlPanel';
import MapStatsBar from '../components/MapStatsBar';
import NYCRequestMap from '../components/NYCRequestMap';
import ChartLoadingOverlay from '../components/ChartLoadingOverlay';
import { DataEmptyState, DataErrorState } from '../components/DataFetchStatus';
import RequestDetailsDrawer from '../components/RequestDetailsDrawer';
import { DEFAULT_FILTERS } from '../context/FilterContext';
import { useAppSnackbar, useSnackbarLoadSync } from '../context/AppSnackbarContext';
import { fetchRequestById } from '../api/requests';
import { CACHE_TTL, getCached, setCached } from '../api/apiCache';
import useCascadingFacets from '../hooks/useCascadingFacets';
import useMapData from '../hooks/useMapData';
import useMinimumLoading from '../hooks/useMinimumLoading';
import useFilterTransitionLoading from '../hooks/useFilterTransitionLoading';
import { PAGE_SECTION_GAP } from '../styles/modelViewLayout';
import { getMapPlotPoints } from '../utils/mapHelpers';

const MAP_PLOT_MIN_HEIGHT = 480;

function hasMapData(data) {
  return Boolean(data?.stats && data?.mapPoints);
}

function MapSkeletonSlot() {
  return (
    <ChartLoadingOverlay loading>
      <Box sx={{ width: '100%', minHeight: MAP_PLOT_MIN_HEIGHT }} />
    </ChartLoadingOverlay>
  );
}

function normalizeRequestResponse(response) {
  return response?.data ?? response?.request ?? response;
}

export default function MapPage() {
  const { beginUserLoad } = useAppSnackbar();
  const [mapFilters, setMapFilters] = useState(() => ({ ...DEFAULT_FILTERS }));
  const [colorMode, setColorMode] = useState('delayBucket');
  const [highDelayOnly, setHighDelayOnly] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mapExtra = useMemo(() => ({ highDelayOnly, mapBuckets: true }), [highDelayOnly]);
  const { facets, facetsReady, facetsLoading } = useCascadingFacets(mapFilters, mapExtra);
  const { data, loading, isRefreshing, error, refetch } = useMapData(mapFilters, mapExtra, {
    enabled: facetsReady,
  });

  const hasEverLoadedRef = useRef(hasMapData(data));

  useEffect(() => {
    if (hasMapData(data)) {
      hasEverLoadedRef.current = true;
    }
  }, [data]);

  const queryKey = JSON.stringify({ filters: mapFilters, extra: mapExtra });

  const dataReady = facetsReady && !loading && !isRefreshing;
  const hasData = hasMapData(data);

  const {
    beginTransition,
    filterTransitionActive,
    visibleFilterTransitioning,
  } = useFilterTransitionLoading({
    filterKey: queryKey,
    hasEverLoadedRef,
    facetsReady,
    facetsLoading,
    loading,
    isRefreshing,
  });

  useSnackbarLoadSync({
    loading: loading || isRefreshing || facetsLoading || filterTransitionActive,
    error,
    queryKey,
  });

  const handleMapFilterChange = useCallback((key, value) => {
    beginUserLoad();
    beginTransition();
    setMapFilters((prev) => ({ ...prev, [key]: value }));
  }, [beginUserLoad, beginTransition]);

  const handleHighDelayOnlyChange = useCallback((value) => {
    beginUserLoad();
    beginTransition();
    setHighDelayOnly(value);
  }, [beginUserLoad, beginTransition]);

  const handleReset = useCallback(() => {
    beginUserLoad();
    beginTransition();
    setMapFilters({ ...DEFAULT_FILTERS });
    setHighDelayOnly(false);
    setColorMode('delayBucket');
    setSelectedRequestId(null);
    setSelectedRequest(null);
    setDrawerOpen(false);
  }, [beginUserLoad, beginTransition]);

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

  const handleSelectRequest = useCallback((request) => {
    const key = request?.unique_key ?? request?._id ?? null;
    setSelectedRequestId(key);
    setSelectedRequest(request);
    setDrawerOpen(true);

    if (!key) return;

    const storeKey = `request:${key}`;
    const cached = normalizeRequestResponse(getCached(storeKey));
    if (cached) {
      setSelectedRequest(cached);
      return;
    }

    fetchRequestById(key)
      .then((raw) => {
        const full = normalizeRequestResponse(raw);
        if (!full) return;
        setCached(storeKey, full, CACHE_TTL.requestDetails);
        setSelectedRequest((prev) => {
          const prevKey = prev?.unique_key ?? prev?._id;
          return prevKey === key ? full : prev;
        });
      })
      .catch(() => {
        /* keep partial map point data in drawer */
      });
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const mapRecords = hasData ? (data.mapPoints?.records ?? []) : [];
  const isEmpty = dataReady && hasData && mapRecords.length === 0;

  const mappedRequestCount = useMemo(
    () => (mapRecords.length ? getMapPlotPoints(mapRecords).length : 0),
    [mapRecords],
  );

  const stats = useMemo(() => {
    if (!hasData || showLoadingState) return null;
    const statsData = data.stats;
    return {
      mappedRequests: mappedRequestCount,
      avgPredictedDelay: statsData.avgPredictedHours ?? 0,
      highDelayCount: statsData.highDelayCount ?? 0,
      unresolvedRate: statsData.unresolvedRate ?? 0,
    };
  }, [hasData, showLoadingState, data, mappedRequestCount]);

  if (!showLoadingState && error && !hasData) {
    return <DataErrorState error={error} onRetry={onRetry} />;
  }

  if (!showLoadingState && isEmpty) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: PAGE_SECTION_GAP, pb: '96px' }}>
        <PageIntro
          page="map"
          eyebrow="Spatial Exploration"
          title="NYC Request Map"
          description="View 311 requests on a real NYC map, colored by delay bucket, complaint type, status, or prediction risk. Markers show a representative sample (~295k records); dashboard totals reflect the full NYC dataset."
        />
        <MapControlPanel
          facets={facets}
          filters={mapFilters}
          colorMode={colorMode}
          highDelayOnly={highDelayOnly}
          onFilterChange={handleMapFilterChange}
          onColorModeChange={setColorMode}
          onHighDelayOnlyChange={handleHighDelayOnlyChange}
          onReset={handleReset}
        />
        <DataEmptyState message="No map points match the current filters." />
      </Box>
    );
  }

  return (
    <>
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: PAGE_SECTION_GAP,
        pb: '96px',
      }}
    >
      <PageIntro
        page="map"
        eyebrow="Spatial Exploration"
        title="NYC Request Map"
        description="View 311 requests on a real NYC map, colored by delay bucket, complaint type, status, or prediction risk. Markers show a representative sample (~295k records); dashboard totals reflect the full NYC dataset."
      />

      <MapControlPanel
        facets={facets}
        filters={mapFilters}
        colorMode={colorMode}
        highDelayOnly={highDelayOnly}
        onFilterChange={handleMapFilterChange}
        onColorModeChange={setColorMode}
        onHighDelayOnlyChange={handleHighDelayOnlyChange}
        onReset={handleReset}
      />

      <PageLoadingBar loading={showLoadingState} page="map" />

      {showLoadingState ? (
        <>
          <MapStatsBar loading />
          <Box sx={{ minHeight: 0 }}>
            <MapSkeletonSlot />
          </Box>
        </>
      ) : (
        <>
          <MapStatsBar stats={stats} />
          <Box sx={{ minHeight: 0 }}>
            <NYCRequestMap
              requests={mapRecords}
              colorMode={colorMode}
              selectedRequestId={selectedRequestId}
              onSelectRequest={handleSelectRequest}
              showModelLink={false}
            />
          </Box>
        </>
      )}
    </Box>

    <RequestDetailsDrawer
      open={drawerOpen}
      request={selectedRequest}
      onClose={handleCloseDrawer}
    />
    </>
  );
}
