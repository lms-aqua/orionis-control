/**
 * AdGuard Home adapter.
 *
 * Talks to AdGuard's documented /control API using HTTP Basic auth. The
 * credentials stay on this server; the iOS app never sees them and never talks
 * to AdGuard directly.
 */
import { createHash } from 'node:crypto';
import { AppError } from '../../lib/errors.ts';
import { UpstreamClient } from '../../lib/http-upstream.ts';
import type {
  AdGuardAdapter,
  AdGuardStats,
  AdGuardStatus,
  CustomRules,
  DnsClient,
  DnsQuery,
  FilterList,
  NameCount,
  ProtectionChange,
  QueryStatus,
  TimeRange,
} from './types.ts';

const REASON =
  'AdGuard Home is not connected to this gateway. Set ADGUARD_INTERNAL_URL, ADGUARD_USERNAME and ADGUARD_PASSWORD and restart the service.';

export class UnconfiguredAdGuardAdapter implements AdGuardAdapter {
  readonly configured = false;
  private fail(): never {
    throw new AppError('SERVICE_NOT_CONFIGURED', REASON);
  }
  async getStatus(): Promise<AdGuardStatus> {
    this.fail();
  }
  async getStats(): Promise<AdGuardStats> {
    this.fail();
  }
  async getQueryLog(): Promise<{ items: DnsQuery[]; oldest: string | null }> {
    this.fail();
  }
  async listClients(): Promise<DnsClient[]> {
    this.fail();
  }
  async listFilters(): Promise<FilterList[]> {
    this.fail();
  }
  async getCustomRules(): Promise<CustomRules> {
    this.fail();
  }
  async setCustomRules(): Promise<void> {
    this.fail();
  }
  async refreshFilters(): Promise<{ updated: number }> {
    this.fail();
  }
  async setProtection(): Promise<AdGuardStatus> {
    this.fail();
  }
  async probe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    return { ok: false, latencyMs: 0, detail: 'SERVICE_NOT_CONFIGURED' };
  }
}

function toNameCounts(raw: unknown): NameCount[] {
  if (!Array.isArray(raw)) return [];
  const out: NameCount[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      for (const [name, count] of Object.entries(entry as Record<string, unknown>)) {
        if (typeof count === 'number') out.push({ name, count });
      }
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/** AdGuard reports query log times as RFC3339 strings; stats as bucket arrays. */
function bucketSeries(
  queries: unknown,
  blocked: unknown,
  range: TimeRange,
): { at: string; queries: number; blocked: number }[] {
  const q = Array.isArray(queries) ? (queries as number[]) : [];
  const b = Array.isArray(blocked) ? (blocked as number[]) : [];
  const n = Math.max(q.length, b.length);
  if (n === 0) return [];

  // AdGuard buckets are hourly for <= 24h ranges and daily beyond that.
  const hourly = range === 'hour' || range === 'today' || range === 'day';
  const stepMs = hourly ? 3_600_000 : 86_400_000;
  const end = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(end - (n - 1 - i) * stepMs).toISOString(),
    queries: q[i] ?? 0,
    blocked: b[i] ?? 0,
  }));
}

export function mapQueryStatus(reason: string | undefined, filtered: boolean): QueryStatus {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('rewrite')) return 'rewritten';
  if (r.includes('safesearch') || r.includes('safe_search')) return 'safe_search';
  // AdGuard's normal allowed reasons are names such as
  // `NotFilteredNotFound`. They contain "filtered", so allowed cases must be
  // classified before the broader blocked check.
  if (
    r.includes('notfiltered') ||
    r.includes('whitelist') ||
    r.includes('allowlist') ||
    (r === '' && !filtered)
  ) {
    return 'allowed';
  }
  if (r.includes('filtered') || r.includes('blocked') || filtered) return 'blocked';
  return 'unknown';
}

/**
 * Stable identity for one upstream log record.
 *
 * Never include the array position: a new query inserted at the top would then
 * change every row id and force SwiftUI to discard/recreate the whole list.
 */
export function queryLogId(fields: {
  at: string;
  client: string;
  domain: string;
  type: string;
  reason?: string;
  rule?: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('base64url').slice(0, 24);
}

/**
 * Validates a custom filtering rule before it is sent upstream.
 * Rejects control characters, absurd length and obviously malformed syntax.
 */
export function validateRule(
  rule: string,
): { ok: true; normalised: string } | { ok: false; reason: string } {
  const trimmed = rule.trim();
  if (!trimmed) return { ok: false, reason: 'The rule is empty.' };
  if (trimmed.length > 512) return { ok: false, reason: 'The rule is longer than 512 characters.' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, reason: 'The rule contains control characters.' };
  }
  if (trimmed.startsWith('!') || trimmed.startsWith('#')) {
    return { ok: true, normalised: trimmed }; // comment
  }
  // Adblock-style, hosts-style, or /regex/
  const adblock = /^(@@)?\|\|[^\s|^]+\^?(\$[\w~,=|.-]+)?$/.test(trimmed);
  const hosts = /^(\d{1,3}(\.\d{1,3}){3}|::|::1)\s+\S+$/.test(trimmed);
  const regex = /^(@@)?\/.+\/$/.test(trimmed);
  const bare = /^(@@)?[a-z0-9*][a-z0-9.*-]*\.[a-z]{2,}$/i.test(trimmed);
  if (!adblock && !hosts && !regex && !bare) {
    return {
      ok: false,
      reason:
        'Unrecognised rule syntax. Use adblock style (||example.com^), an allow rule (@@||example.com^), or hosts style (0.0.0.0 example.com).',
    };
  }
  return { ok: true, normalised: trimmed };
}

export class HttpAdGuardAdapter implements AdGuardAdapter {
  readonly configured = true;
  private readonly client: UpstreamClient;

  constructor(
    baseUrl: string,
    username: string,
    password: string,
    timeoutMs: number,
    fetchImpl: typeof fetch = fetch,
  ) {
    const basic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    this.client = new UpstreamClient(
      'AdGuard Home',
      baseUrl,
      { authorization: `Basic ${basic}`, accept: 'application/json' },
      timeoutMs,
      fetchImpl,
    );
  }

  async getStatus(): Promise<AdGuardStatus> {
    const [{ data: status }, filtering] = await Promise.all([
      this.client.request<Record<string, unknown>>({ path: '/control/status' }),
      this.client
        .request<Record<string, unknown>>({ path: '/control/filtering/status' })
        .catch(() => ({ data: {} as Record<string, unknown> })),
    ]);

    const disabledDurationMs =
      typeof status.protection_disabled_duration === 'number'
        ? status.protection_disabled_duration
        : null;

    return {
      protectionEnabled: Boolean(status.protection_enabled),
      running: Boolean(status.running ?? true),
      version: typeof status.version === 'string' ? status.version : null,
      dnsPort: typeof status.dns_port === 'number' ? status.dns_port : null,
      protectionDisabledUntil:
        disabledDurationMs && disabledDurationMs > 0
          ? new Date(Date.now() + disabledDurationMs).toISOString()
          : null,
      filteringEnabled: Boolean(filtering.data.enabled ?? status.protection_enabled),
      safeBrowsingEnabled:
        typeof status.safebrowsing_enabled === 'boolean' ? status.safebrowsing_enabled : null,
      parentalEnabled:
        typeof status.parental_enabled === 'boolean' ? status.parental_enabled : null,
      checkedAt: new Date().toISOString(),
    };
  }

  async getStats(range: TimeRange): Promise<AdGuardStats> {
    const { data } = await this.client.request<Record<string, unknown>>({ path: '/control/stats' });

    const total = Number(data.num_dns_queries ?? 0);
    const blocked = Number(data.num_blocked_filtering ?? 0);
    const series = bucketSeries(data.dns_queries, data.blocked_filtering, range);

    // AdGuard's /control/stats returns the whole retained window. Trim the
    // series to the requested range so the chart matches the selector.
    const keep =
      range === 'hour' ? 1 : range === 'today' || range === 'day' ? 24 : range === 'week' ? 7 : 30;
    const trimmed = series.slice(-keep);
    const rangeTotal = trimmed.reduce((n, p) => n + p.queries, 0);
    const rangeBlocked = trimmed.reduce((n, p) => n + p.blocked, 0);
    const useRange = trimmed.length > 0 && trimmed.length < series.length;

    const effectiveTotal = useRange ? rangeTotal : total;
    const effectiveBlocked = useRange ? rangeBlocked : blocked;

    return {
      range,
      totalQueries: effectiveTotal,
      blockedQueries: effectiveBlocked,
      blockedPercent: effectiveTotal > 0 ? (effectiveBlocked / effectiveTotal) * 100 : 0,
      replacedSafeBrowsing: Number(data.num_replaced_safebrowsing ?? 0),
      replacedParental: Number(data.num_replaced_parental ?? 0),
      averageProcessingMs: Number(data.avg_processing_time ?? 0) * 1000,
      topClients: toNameCounts(data.top_clients).slice(0, 20),
      topQueriedDomains: toNameCounts(data.top_queried_domains).slice(0, 20),
      topBlockedDomains: toNameCounts(data.top_blocked_domains).slice(0, 20),
      series: trimmed,
    };
  }

  async getQueryLog(opts: {
    limit: number;
    olderThan?: string;
    search?: string;
    status?: 'all' | 'blocked' | 'allowed';
  }): Promise<{ items: DnsQuery[]; oldest: string | null }> {
    const { data } = await this.client.request<Record<string, unknown>>({
      path: '/control/querylog',
      query: {
        limit: opts.limit,
        older_than: opts.olderThan,
        search: opts.search,
        response_status:
          opts.status === 'blocked' ? 'blocked' : opts.status === 'allowed' ? 'processed' : 'all',
      },
    });

    const raw = Array.isArray(data.data) ? (data.data as Record<string, unknown>[]) : [];
    const items: DnsQuery[] = raw.map((r) => {
      const question = (r.question ?? {}) as Record<string, unknown>;
      const matchedRules = Array.isArray(r.rules) ? (r.rules as Record<string, unknown>[]) : [];
      const firstRule = matchedRules[0];
      const legacyFilterId =
        typeof r.filterId === 'number'
          ? r.filterId
          : typeof r.filter_id === 'number'
            ? r.filter_id
            : null;
      const ruleFilterId =
        legacyFilterId ??
        (typeof firstRule?.filter_list_id === 'number' ? firstRule.filter_list_id : null);
      const ruleText =
        typeof r.rule === 'string'
          ? r.rule
          : typeof firstRule?.text === 'string'
            ? firstRule.text
            : null;
      const at = typeof r.time === 'string' ? r.time : new Date().toISOString();
      const domain = String(question.name ?? question.host ?? '');
      const client = String(r.client ?? '');
      const type = String(question.type ?? '');
      const reason = typeof r.reason === 'string' ? r.reason : undefined;
      return {
        id: queryLogId({ at, client, domain, type, reason, rule: ruleText }),
        at,
        client,
        clientName:
          typeof r.client_info === 'object' && r.client_info
            ? (((r.client_info as Record<string, unknown>).name as string) ?? null)
            : null,
        domain,
        type,
        upstream: typeof r.upstream === 'string' ? r.upstream : null,
        processingMs:
          typeof r.elapsedMs === 'string'
            ? Number.parseFloat(r.elapsedMs)
            : typeof r.elapsedMs === 'number'
              ? r.elapsedMs
              : null,
        status: mapQueryStatus(
          reason,
          // Filter id 0 is a valid custom-list id, not a useful boolean. A
          // concrete rule is stronger legacy evidence when reason is absent.
          Boolean(ruleText && !ruleText.trim().startsWith('@@')),
        ),
        rule: ruleText,
        ruleFilterId,
        responseCode: typeof r.status === 'string' ? r.status : null,
        answers: Array.isArray(r.answer)
          ? (r.answer as Record<string, unknown>[]).map((a) => String(a.value ?? ''))
          : [],
      };
    });

    return { items, oldest: typeof data.oldest === 'string' ? data.oldest : null };
  }

  async listClients(): Promise<DnsClient[]> {
    const { data } = await this.client.request<Record<string, unknown>>({
      path: '/control/clients',
    });
    const configured = Array.isArray(data.clients)
      ? (data.clients as Record<string, unknown>[])
      : [];
    const auto = Array.isArray(data.auto_clients)
      ? (data.auto_clients as Record<string, unknown>[])
      : [];

    const fromConfigured: DnsClient[] = configured.map((c) => ({
      id: String(c.name ?? ''),
      name: String(c.name ?? ''),
      ids: Array.isArray(c.ids) ? (c.ids as string[]) : [],
      useGlobalSettings: Boolean(c.use_global_settings),
      filteringEnabled: Boolean(c.filtering_enabled),
      safeBrowsingEnabled: Boolean(c.safebrowsing_enabled),
      parentalEnabled: Boolean(c.parental_enabled),
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
      lastSeenAt: null,
      queryCount: null,
      blockedCount: null,
    }));

    const fromAuto: DnsClient[] = auto.map((c) => ({
      id: String(c.ip ?? ''),
      name: String(c.name ?? c.ip ?? ''),
      ids: [String(c.ip ?? '')],
      useGlobalSettings: true,
      filteringEnabled: true,
      safeBrowsingEnabled: false,
      parentalEnabled: false,
      tags: [],
      lastSeenAt: null,
      queryCount: null,
      blockedCount: null,
    }));

    const seen = new Set(fromConfigured.flatMap((c) => c.ids));
    return [...fromConfigured, ...fromAuto.filter((c) => !c.ids.some((id) => seen.has(id)))];
  }

  async listFilters(): Promise<FilterList[]> {
    const { data } = await this.client.request<Record<string, unknown>>({
      path: '/control/filtering/status',
    });
    const map = (raw: unknown, whitelist: boolean): FilterList[] =>
      Array.isArray(raw)
        ? (raw as Record<string, unknown>[]).map((f) => ({
            id: Number(f.id ?? 0),
            name: String(f.name ?? ''),
            url: String(f.url ?? ''),
            enabled: Boolean(f.enabled),
            ruleCount: Number(f.rules_count ?? 0),
            lastUpdatedAt: typeof f.last_updated === 'string' ? f.last_updated : null,
            whitelist,
          }))
        : [];
    return [...map(data.filters, false), ...map(data.whitelist_filters, true)];
  }

  async getCustomRules(): Promise<CustomRules> {
    const { data } = await this.client.request<Record<string, unknown>>({
      path: '/control/filtering/status',
    });
    return { rules: Array.isArray(data.user_rules) ? (data.user_rules as string[]) : [] };
  }

  async setCustomRules(rules: string[]): Promise<void> {
    await this.client.request({
      method: 'POST',
      path: '/control/filtering/set_rules',
      body: { rules },
    });
  }

  async refreshFilters(whitelist: boolean): Promise<{ updated: number }> {
    const { data } = await this.client.request<Record<string, unknown>>({
      method: 'POST',
      path: '/control/filtering/refresh',
      body: { whitelist },
    });
    return { updated: Number(data?.updated ?? 0) };
  }

  async setProtection(change: ProtectionChange): Promise<AdGuardStatus> {
    const body: Record<string, unknown> = { enabled: change.enabled };
    if (!change.enabled && change.durationSeconds) {
      body.duration = change.durationSeconds * 1000; // AdGuard expects ms
    }

    try {
      await this.client.request({ method: 'POST', path: '/control/protection', body });
    } catch (err) {
      // Older AdGuard builds have no /control/protection; fall back.
      if (err instanceof AppError && (err.code === 'NOT_FOUND' || err.code === 'UPSTREAM_ERROR')) {
        await this.client.request({
          method: 'POST',
          path: '/control/dns_config',
          body: { protection_enabled: change.enabled },
        });
      } else {
        throw err;
      }
    }

    return this.getStatus();
  }

  async probe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    return this.client.probe('/control/status');
  }
}
