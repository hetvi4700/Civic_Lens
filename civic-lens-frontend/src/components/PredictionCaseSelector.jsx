import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Chip,
  Stack,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  CircularProgress,
  IconButton,
  alpha,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { useAppColors, useColorMode } from '../ColorModeContext';
import { cardSubtitleSx, cardTitleSx } from '../styles/modelViewLayout';
import {
  filterRowGridSx,
  filterToolbarShellSx,
  getFilterFieldSx,
  filterSecondaryRowSx,
} from '../styles/filterControls';
import { getActiveFilterChipSx } from '../theme';
import { DEFAULT_FILTERS } from '../context/FilterContext';
import useCascadingFacets from '../hooks/useCascadingFacets';
import useCaseList, { caseListQueryKey } from '../hooks/useCaseList';
import { facetToOptionsWithSelection } from '../utils/facetOptions';
import { formatHours } from '../utils/analytics';
import { getDelayBucketColor } from '../utils/mapHelpers';

const FILTER_KEYS = [
  { key: 'borough', field: 'borough', label: 'Borough' },
  { key: 'complaint_type', field: 'complaint_type', label: 'Complaint Type' },
  { key: 'agency', field: 'agency', label: 'Agency' },
  { key: 'delay_bucket', field: 'delay_bucket', label: 'Delay Bucket' },
  { key: 'status', field: 'status', label: 'Status' },
];

const FILTER_LABELS = Object.fromEntries(
  FILTER_KEYS.map(({ key, label }) => [key, label]),
);

const SORT_OPTIONS = [
  { value: 'predicted_delay_desc', label: 'Predicted delay (longest first)' },
  { value: 'predicted_delay_asc', label: 'Predicted delay (shortest first)' },
  { value: 'created_date_desc', label: 'Most recent' },
];

const LIST_MAX_HEIGHT = 360;
const ROW_HEIGHT = 52;

function truncate(text, max = 32) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatCaseOptionLabel(record) {
  if (!record) return '';
  const complaint = truncate(record.complaint_type, 28);
  const borough = record.borough ?? '—';
  const zip = record.incident_zip ?? '—';
  const bucket = record.predicted_delay_bucket ?? '—';
  return `${complaint} | ${borough} | ${zip} | ${bucket}`;
}

function formatSelectedSummary(record) {
  if (!record) return '';
  const parts = [
    truncate(record.complaint_type, 36),
    record.borough ?? '—',
    record.incident_zip ?? '—',
    record.predicted_delay_bucket ?? '—',
  ];
  return parts.join(' | ');
}

function CaseDelayBadge({ record, colors, mode }) {
  const hours = Number(record?.predicted_response_hours) || 0;
  const bucket = record?.predicted_delay_bucket ?? '—';
  const accent = getDelayBucketColor(bucket, mode);

  return (
    <Chip
      size="small"
      label={`${formatHours(hours)} · ${bucket}`}
      sx={{
        flexShrink: 0,
        height: 22,
        fontSize: '0.68rem',
        fontWeight: 700,
        bgcolor: alpha(accent, 0.12),
        border: `1px solid ${alpha(accent, 0.28)}`,
        color: accent,
        '& .MuiChip-label': { px: 0.75 },
      }}
    />
  );
}

function CaseListRow({ record, selected, highlighted, onSelect, colors, mode, accent }) {
  const isSelected = selected?.unique_key === record.unique_key;

  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect(record)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        width: '100%',
        minHeight: ROW_HEIGHT,
        px: 1.5,
        py: 0.75,
        border: 'none',
        borderBottom: `1px solid ${colors.border}`,
        bgcolor: isSelected
          ? alpha(accent, 0.1)
          : highlighted
            ? alpha(accent, 0.06)
            : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background-color 0.12s ease',
        '&:hover': {
          bgcolor: alpha(accent, 0.06),
        },
        '&:last-of-type': {
          borderBottom: 'none',
        },
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          variant="body2"
          sx={{
            ...cardSubtitleSx,
            color: colors.textPrimary,
            fontWeight: isSelected ? 700 : 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {formatCaseOptionLabel(record)}
        </Typography>
        {record.unique_key ? (
          <Typography
            variant="caption"
            component="span"
            sx={{
              display: 'block',
              color: colors.textSecondary,
              fontSize: '0.68rem',
              lineHeight: 1.2,
              opacity: 0.85,
            }}
          >
            #{record.unique_key}
          </Typography>
        ) : null}
      </Box>
      <CaseDelayBadge record={record} colors={colors} mode={mode} />
    </Box>
  );
}

export default function PredictionCaseSelector({
  initialFilters = DEFAULT_FILTERS,
  selectedRequest = null,
  onSelectRequest,
  onFirstRecords,
  onCasesEmpty,
}) {
  const colors = useAppColors();
  const { mode } = useColorMode();
  const accent = colors.accentPink;

  const [pickerFilters, setPickerFilters] = useState(() => ({ ...initialFilters }));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('predicted_delay_desc');
  const [listOpen, setListOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const { facets, facetsReady } = useCascadingFacets(pickerFilters, { mlOnly: true });
  const {
    records,
    total,
    hasMore,
    loading,
    loadingMore,
    countLoading,
    error,
    hasFetched,
    loadMore,
  } = useCaseList(pickerFilters, { search, sort, enabled: facetsReady });

  const listQueryKey = useMemo(
    () => caseListQueryKey({ filters: pickerFilters, search, sort }),
    [pickerFilters, search, sort],
  );

  const listRef = useRef(null);
  const sentinelRef = useRef(null);
  const firstRecordsSentRef = useRef(false);

  const optionsByKey = useMemo(() => {
    const map = {};
    FILTER_KEYS.forEach(({ key, field }) => {
      map[key] = facetToOptionsWithSelection(facets, field, pickerFilters[key]);
    });
    return map;
  }, [facets, pickerFilters]);

  const activeFilters = useMemo(
    () => Object.entries(pickerFilters).filter(([, value]) => value && value !== 'All'),
    [pickerFilters],
  );

  const handleFacetChange = useCallback((key) => (event) => {
    setPickerFilters((prev) => ({ ...prev, [key]: event.target.value }));
  }, []);

  const handleRemoveFilter = useCallback((key) => {
    setPickerFilters((prev) => ({ ...prev, [key]: 'All' }));
  }, []);

  const openList = useCallback(() => {
    setListOpen(true);
  }, []);

  const handleSelectCase = useCallback((record) => {
    onSelectRequest?.(record);
    setListOpen(false);
    setHighlightedIndex(-1);
  }, [onSelectRequest]);

  const handleSearchKeyDown = useCallback((event) => {
    if (!records.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!listOpen) setListOpen(true);
      setHighlightedIndex((prev) => (prev < records.length - 1 ? prev + 1 : 0));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!listOpen) setListOpen(true);
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : records.length - 1));
      return;
    }

    if (event.key === 'Enter') {
      if (!listOpen) {
        setListOpen(true);
        return;
      }
      if (highlightedIndex >= 0 && highlightedIndex < records.length) {
        event.preventDefault();
        handleSelectCase(records[highlightedIndex]);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setListOpen(false);
      setHighlightedIndex(-1);
    }
  }, [records, listOpen, highlightedIndex, handleSelectCase]);

  useEffect(() => {
    if (highlightedIndex >= records.length) {
      setHighlightedIndex(records.length ? records.length - 1 : -1);
    }
  }, [records.length, highlightedIndex]);

  useEffect(() => {
    const root = listRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !listOpen) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { root, rootMargin: '120px', threshold: 0 },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, records.length, hasMore, listOpen]);

  useEffect(() => {
    firstRecordsSentRef.current = false;
  }, [listQueryKey]);

  useEffect(() => {
    if (!facetsReady || loading || !hasFetched || firstRecordsSentRef.current) return;
    firstRecordsSentRef.current = true;
    if (records.length) {
      onFirstRecords?.(records);
    } else {
      onCasesEmpty?.();
    }
  }, [facetsReady, loading, hasFetched, records, onFirstRecords, onCasesEmpty]);

  const countLabel = useMemo(() => {
    if (loading && !records.length) return 'Searching cases…';
    if (total == null) {
      if (countLoading) return 'Counting matches…';
      if (!records.length) return 'No cases match';
      return `${records.length.toLocaleString()} case${records.length === 1 ? '' : 's'} shown`;
    }
    return `${total.toLocaleString()} case${total === 1 ? '' : 's'} match`;
  }, [loading, records.length, total, countLoading]);

  return (
    <Box sx={filterToolbarShellSx}>
      <Typography
        variant="subtitle2"
        component="label"
        sx={{ ...cardTitleSx, color: colors.textSecondary, display: 'block', mb: 1 }}
      >
        Select Case
      </Typography>

      {activeFilters.length > 0 && (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1.25 }}>
          {activeFilters.map(([key, value]) => (
            <Chip
              key={key}
              title={`${FILTER_LABELS[key] ?? key}: ${value}`}
              label={truncate(value, 28)}
              size="small"
              onDelete={() => handleRemoveFilter(key)}
              sx={getActiveFilterChipSx(colors, colors.primary)}
            />
          ))}
        </Stack>
      )}

      <Box sx={filterRowGridSx(5)}>
        {FILTER_KEYS.map(({ key, label }) => (
          <FormControl key={key} size="small" sx={getFilterFieldSx(colors, 'model')}>
            <InputLabel id={`case-filter-${key}`}>{label}</InputLabel>
            <Select
              labelId={`case-filter-${key}`}
              value={pickerFilters[key] ?? 'All'}
              label={label}
              onChange={handleFacetChange(key)}
            >
              {(optionsByKey[key] || ['All']).map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ))}
      </Box>

      <Box sx={{ ...filterSecondaryRowSx, mt: '14px', alignItems: 'center' }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search within results…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onFocus={openList}
          onClick={openList}
          onKeyDown={handleSearchKeyDown}
          slotProps={{
            input: {
              startAdornment: (
                <SearchIcon sx={{ color: colors.textSecondary, fontSize: 18, ml: 0.5, mr: 0.5 }} />
              ),
              endAdornment: (
                <IconButton
                  size="small"
                  aria-label={listOpen ? 'Close case list' : 'Open case list'}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setListOpen((open) => !open)}
                  sx={{ color: colors.textSecondary, mr: 0.25 }}
                >
                  {listOpen ? (
                    <KeyboardArrowUpIcon sx={{ fontSize: 20 }} />
                  ) : (
                    <KeyboardArrowDownIcon sx={{ fontSize: 20 }} />
                  )}
                </IconButton>
              ),
            },
          }}
          sx={{
            ...getFilterFieldSx(colors, 'model'),
            flex: 1,
            minWidth: { xs: '100%', sm: 240 },
          }}
        />

        <FormControl
          size="small"
          sx={{
            ...getFilterFieldSx(colors, 'model'),
            minWidth: { xs: '100%', sm: 260 },
            flexShrink: 0,
          }}
        >
          <InputLabel id="case-sort-label">Sort</InputLabel>
          <Select
            labelId="case-sort-label"
            value={sort}
            label="Sort"
            onChange={(event) => setSort(event.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {listOpen ? (
        <>
          <Typography
            variant="caption"
            sx={{
              display: 'block',
              mt: 1.25,
              mb: 0.75,
              color: colors.textSecondary,
              fontWeight: 600,
              letterSpacing: '0.02em',
            }}
          >
            {countLabel}
          </Typography>

          <Box
            ref={listRef}
            sx={{
              maxHeight: LIST_MAX_HEIGHT,
              overflowY: 'auto',
              borderRadius: '12px',
              border: `1px solid ${colors.border}`,
              bgcolor: colors.cardSurface,
              boxShadow: colors.cardShadow,
            }}
          >
            {error ? (
              <Typography variant="body2" sx={{ p: 2, color: colors.error }}>
                {error.message}
              </Typography>
            ) : null}

            {!error && loading && !records.length ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={24} sx={{ color: accent }} />
              </Box>
            ) : null}

            {!error && !loading && records.length === 0 ? (
              <Typography variant="body2" sx={{ p: 2, color: colors.textSecondary }}>
                No matching cases. Try removing a filter or broadening your search.
              </Typography>
            ) : null}

            {records.map((record, index) => (
              <CaseListRow
                key={`${record.unique_key ?? record._id ?? 'case'}-${index}`}
                record={record}
                selected={selectedRequest}
                highlighted={highlightedIndex === index}
                onSelect={handleSelectCase}
                colors={colors}
                mode={mode}
                accent={accent}
              />
            ))}

            {hasMore ? (
              <Box
                ref={sentinelRef}
                sx={{
                  display: 'flex',
                  justifyContent: 'center',
                  py: 1.5,
                  borderTop: records.length ? `1px solid ${colors.border}` : 'none',
                }}
              >
                {loadingMore ? (
                  <CircularProgress size={20} sx={{ color: accent }} />
                ) : (
                  <Typography variant="caption" sx={{ color: colors.textSecondary }}>
                    Scroll for more…
                  </Typography>
                )}
              </Box>
            ) : null}
          </Box>
        </>
      ) : null}

      {selectedRequest ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1.25 }}>
          <Chip
            size="small"
            label={formatSelectedSummary(selectedRequest)}
            title={formatSelectedSummary(selectedRequest)}
            sx={{
              maxWidth: '100%',
              height: 'auto',
              py: 0.5,
              '& .MuiChip-label': {
                ...cardSubtitleSx,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: 'block',
                color: colors.textSecondary,
              },
              bgcolor: alpha(accent, 0.06),
              border: `1px solid ${alpha(accent, 0.2)}`,
            }}
          />
        </Box>
      ) : null}
    </Box>
  );
}
