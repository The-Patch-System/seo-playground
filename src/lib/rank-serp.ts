export interface RankSerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  url?: string;
  title?: string;
  domain?: string;
  references?: Array<{ domain?: string; url?: string }> | null;
  items?: Array<{ references?: Array<{ domain?: string; url?: string }> | null }> | null;
}

export interface RankSerpMatch {
  position: number | null;
  url: string | null;
  title: string | null;
  /** Whether Google's AI Overview cites the domain; null when the SERP had no AI Overview. */
  aiOverview: boolean | null;
}

/** Host of a tracked domain or SERP URL, without scheme, "www." or path. */
export function rankHost(value: string): string {
  return value.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

/**
 * Stops the crawl at the first results page that lists the domain, so a check is billed
 * for the pages up to the match instead of the full depth.
 */
export function stopCrawlOnMatch(domain: string) {
  return [{ match_type: 'with_subdomains', match_value: rankHost(domain) }];
}

/** Finds the tracked domain in an Advanced SERP: its organic position and any AI Overview citation. */
export function matchRankSerp(items: RankSerpItem[], trackedDomain: string): RankSerpMatch {
  const domain = rankHost(trackedDomain);
  const matches = (value: string | undefined) => {
    const host = rankHost(value ?? '');
    return host === domain || host.endsWith(`.${domain}`);
  };

  const hit = items.find((item) => item.type === 'organic' && matches(item.domain ?? item.url));
  const overviews = items.filter((item) => item.type === 'ai_overview');
  const cited = overviews.some((overview) => [
    ...(overview.references ?? []),
    ...(overview.items ?? []).flatMap((element) => element.references ?? []),
  ].some((reference) => matches(reference.domain ?? reference.url)));

  return {
    // rank_group is the organic position; rank_absolute includes maps, ads and other SERP modules.
    position: hit?.rank_group ?? hit?.rank_absolute ?? null,
    url: hit?.url ?? null,
    title: hit?.title ?? null,
    aiOverview: overviews.length > 0 ? cited : null,
  };
}
