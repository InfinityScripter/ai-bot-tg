/** One complete API-history sweep. Baseline records the archive without posting. */
export interface WhenResetSummary {
  fetched: number;
  baselined: boolean;
  fresh: number;
  recovered: number;
  failed: number;
}
