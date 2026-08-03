/** Normalised AdGuard Home domain model. */

export type TimeRange = 'hour' | 'today' | 'day' | 'week' | 'month';

export interface AdGuardStatus {
  protectionEnabled: boolean;
  running: boolean;
  version: string | null;
  dnsPort: number | null;
  protectionDisabledUntil: string | null;
  filteringEnabled: boolean;
  safeBrowsingEnabled: boolean | null;
  parentalEnabled: boolean | null;
  checkedAt: string;
}

export interface NameCount {
  name: string;
  count: number;
}

export interface AdGuardStats {
  range: TimeRange;
  totalQueries: number;
  blockedQueries: number;
  blockedPercent: number;
  replacedSafeBrowsing: number;
  replacedParental: number;
  averageProcessingMs: number;
  topClients: NameCount[];
  topQueriedDomains: NameCount[];
  topBlockedDomains: NameCount[];
  /** Aligned series for charting; index 0 is oldest. */
  series: { at: string; queries: number; blocked: number }[];
}

export type QueryStatus = 'allowed' | 'blocked' | 'rewritten' | 'safe_search' | 'unknown';

export interface DnsQuery {
  id: string;
  at: string;
  client: string;
  clientName: string | null;
  domain: string;
  type: string;
  upstream: string | null;
  processingMs: number | null;
  status: QueryStatus;
  rule: string | null;
  ruleFilterId: number | null;
  responseCode: string | null;
  /** Exact upstream filtering reason, retained for honest diagnostics. */
  reason: string | null;
  answers: string[];
}

export interface DnsClient {
  id: string;
  name: string;
  ids: string[];
  useGlobalSettings: boolean;
  filteringEnabled: boolean;
  safeBrowsingEnabled: boolean;
  parentalEnabled: boolean;
  tags: string[];
  lastSeenAt: string | null;
  queryCount: number | null;
  blockedCount: number | null;
}

export interface FilterList {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  ruleCount: number;
  lastUpdatedAt: string | null;
  whitelist: boolean;
}

export interface CustomRules {
  rules: string[];
}

export interface ProtectionChange {
  enabled: boolean;
  /** Seconds; null means indefinite. */
  durationSeconds: number | null;
  reason: string | null;
}

export interface AdGuardAdapter {
  readonly configured: boolean;
  getStatus(): Promise<AdGuardStatus>;
  getStats(range: TimeRange): Promise<AdGuardStats>;
  getQueryLog(opts: {
    limit: number;
    olderThan?: string;
    search?: string;
    status?: 'all' | 'blocked' | 'allowed';
  }): Promise<{ items: DnsQuery[]; oldest: string | null; scannedCount: number }>;
  listClients(): Promise<DnsClient[]>;
  listFilters(): Promise<FilterList[]>;
  getCustomRules(): Promise<CustomRules>;
  setCustomRules(rules: string[]): Promise<void>;
  refreshFilters(whitelist: boolean): Promise<{ updated: number }>;
  setProtection(change: ProtectionChange): Promise<AdGuardStatus>;
  probe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}
