import { fetchArticleText } from './lib/article.mjs';
import { DEFAULT_MODEL, QuotaExhausted } from './lib/gemini.mjs';
import { fetchTopComments, fetchTopStories } from './lib/hn.mjs';
import { getSecret } from './lib/secrets.mjs';
import { createStore } from './lib/store.mjs';
import { summarizeDiscussion, summarizeStory } from './lib/summarize.mjs';
import { mapLimit } from './lib/text.mjs';

const TOP_N = Number(process.env.TOP_N || 150);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_AI_CALLS = Number(process.env.MAX_AI_CALLS || 60); // per run, caps cost
const MAX_DISCUSSION_REFRESHES = 2;
const CACHE_HOURS = (WINDOW_DAYS + 1) * 24; // outlive the window so nothing is summarised twice

/** Re-summarise the discussion once a thread has grown substantially. */
function discussionIsStale(entry, comments) {
  if ((entry.discussionRefreshes ?? 0) >= MAX_DISCUSSION_REFRESHES) return false;
  const seen = entry.discussionComments ?? 0;
  return comments >= 5 && comments >= Math.max(seen * 2, seen + 15);
}

export async function handler() {
  const store = createStore();
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const [stories, cache, apiKey] = await Promise.all([
    fetchTopStories({ days: WINDOW_DAYS, limit: TOP_N }),
    store.readJson('cache/summaries.json').then((c) => c ?? {}),
    process.env.MOCK_AI ? null : getSecret(process.env.GEMINI_KEY_PARAM, 'GEMINI_API_KEY'),
  ]);

  let budget = MAX_AI_CALLS;
  const stats = { stories: stories.length, summarized: 0, discussionRefreshed: 0, failed: 0, inputTokens: 0, outputTokens: 0, models: new Set() };
  const track = ({ usage, modelVersion }) => {
    stats.inputTokens += usage.promptTokenCount ?? 0;
    stats.outputTokens += (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    stats.models.add(modelVersion);
  };

  await mapLimit(stories, 2, async (story) => {
    const entry = cache[story.id];
    try {
      if (!entry?.summary) {
        if (budget-- <= 0) return;
        const [articleText, comments] = await Promise.all([
          fetchArticleText(story.url),
          story.comments >= 3 ? fetchTopComments(story.id) : [],
        ]);
        const result = await summarizeStory({ apiKey, model, story, articleText, comments });
        track(result);
        const { summary, tags, discussion, sourceAvailable } = result.value;
        cache[story.id] = {
          summary, tags: tags.slice(0, 2), discussion, sourceAvailable,
          discussionComments: story.comments, discussionRefreshes: 0,
          createdAt: story.createdAt, model: result.modelVersion,
        };
        stats.summarized++;
      } else if (discussionIsStale(entry, story.comments)) {
        if (budget-- <= 0) return;
        const comments = await fetchTopComments(story.id);
        const result = await summarizeDiscussion({ apiKey, model, story, comments });
        track(result);
        Object.assign(entry, {
          discussion: result.value.discussion,
          discussionComments: story.comments,
          discussionRefreshes: (entry.discussionRefreshes ?? 0) + 1,
        });
        stats.discussionRefreshed++;
      }
    } catch (e) {
      stats.failed++;
      if (e instanceof QuotaExhausted) budget = 0; // skip the rest; next hour retries
      console.error(`story ${story.id} failed:`, e.message.slice(0, 500));
    }
  });

  const cutoff = Date.now() / 1000 - CACHE_HOURS * 3600;
  for (const [id, e] of Object.entries(cache)) if (e.createdAt < cutoff) delete cache[id];

  const output = {
    updatedAt: Date.now(),
    windowDays: WINDOW_DAYS,
    stories: stories.map(({ text, ...s }) => {
      const e = cache[s.id];
      return {
        ...s,
        summary: e?.summary ?? null,
        tags: e?.tags ?? [],
        discussion: e?.discussion || null,
        sourceAvailable: e?.sourceAvailable ?? null,
      };
    }),
  };

  await Promise.all([
    store.writeJson('cache/summaries.json', cache),
    store.writeJson('data/stories.json', output, { cacheControl: 'public, max-age=120' }),
  ]);

  const summary = { ...stats, models: [...stats.models] };
  console.log(JSON.stringify(summary));
  return summary;
}
