import { fragmentToText, truncate } from './text.mjs';

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Each day of age costs a story 5% of its points when ranking: 550 points a week ago
// (worth ~385) ranks below 500 today, but 1,000 five days ago (~775) still beats 700 today.
const DAILY_DECAY = 0.95;

/**
 * The `limit` top stories posted in the last `days`, ranked by points with a gentle
 * preference for newer ones, so close calls go to the fresher story.
 */
export async function fetchTopStories({ days = 7, limit = 150, minPoints = 100 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const since = now - days * 86400;
  const score = (h) => h.points * DAILY_DECAY ** ((now - h.created_at_i) / 86400);
  const { hits } = await getJson(
    `${ALGOLIA}/search?tags=story&numericFilters=created_at_i>${since},points>=${minPoints}&hitsPerPage=1000`,
  );
  return hits
    .filter((h) => h.title)
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((h) => ({
      id: h.objectID,
      title: h.title,
      url: h.url || null,
      author: h.author,
      points: h.points,
      comments: h.num_comments ?? 0,
      createdAt: h.created_at_i,
      text: h.story_text ? fragmentToText(h.story_text) : null,
    }));
}

/** First `n` top-level comments in HN's own ranking order. */
export async function fetchTopComments(id, n = 10) {
  const item = await getJson(`${FIREBASE}/item/${id}.json`);
  const kids = (item?.kids ?? []).slice(0, n);
  const comments = await Promise.all(
    kids.map((k) => getJson(`${FIREBASE}/item/${k}.json`).catch(() => null)),
  );
  return comments
    .filter((c) => c && !c.deleted && !c.dead && c.text)
    .map((c) => truncate(fragmentToText(c.text), 600));
}
