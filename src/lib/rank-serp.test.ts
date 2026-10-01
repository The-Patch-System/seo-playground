import { describe, it, expect } from 'vitest';
import { matchRankSerp, rankHost, stopCrawlOnMatch } from './rank-serp';

const organic = (rank_group: number, domain: string) => ({
  type: 'organic', rank_group, rank_absolute: rank_group + 3, domain, url: `https://${domain}/page`, title: domain,
});

describe('matchRankSerp', () => {
  it('returns the organic position of the tracked domain, including www and subdomains', () => {
    const items = [organic(1, 'fr.wikipedia.org'), organic(2, 'www.example.com'), organic(3, 'blog.example.com')];
    expect(matchRankSerp(items, 'https://www.example.com/')).toEqual({
      position: 2, url: 'https://www.example.com/page', title: 'www.example.com', aiOverview: null,
    });
  });

  it('does not match a domain that merely ends with the tracked name', () => {
    expect(matchRankSerp([organic(1, 'www.notexample.com')], 'example.com').position).toBeNull();
  });

  it('reports an AI Overview citation even when the domain has no organic position', () => {
    const items = [
      { type: 'ai_overview', rank_group: 1, references: [{ domain: 'fr.wikipedia.org' }], items: [{ references: [{ domain: 'example.com' }] }] },
      organic(1, 'fr.wikipedia.org'),
    ];
    expect(matchRankSerp(items, 'example.com')).toEqual({ position: null, url: null, title: null, aiOverview: true });
  });

  it('distinguishes an AI Overview that cites other sites from a SERP without one', () => {
    const overview = { type: 'ai_overview', references: [{ domain: 'fr.wikipedia.org' }], items: null };
    expect(matchRankSerp([overview, organic(1, 'example.com')], 'example.com').aiOverview).toBe(false);
    expect(matchRankSerp([organic(1, 'example.com')], 'example.com').aiOverview).toBeNull();
  });
});

describe('stopCrawlOnMatch', () => {
  it('targets the bare host with its subdomains', () => {
    expect(rankHost('https://www.Example.com/fr/')).toBe('example.com');
    expect(stopCrawlOnMatch('https://www.example.com/fr/')).toEqual([{ match_type: 'with_subdomains', match_value: 'example.com' }]);
  });
});
