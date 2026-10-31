import { generateJson } from './gemini.mjs';

export const TAGS = [
  'AI', 'Programming', 'Security', 'Startups', 'Business', 'Science', 'Hardware', 'Web',
  'Open Source', 'Policy', 'Design', 'Culture', 'Show HN', 'Ask HN', 'Other',
];

const STORY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING', enum: TAGS } },
    discussion: { type: 'STRING' },
    sourceAvailable: { type: 'BOOLEAN' },
  },
  required: ['summary', 'tags', 'discussion', 'sourceAvailable'],
};

const DISCUSSION_SCHEMA = {
  type: 'OBJECT',
  properties: { discussion: { type: 'STRING' } },
  required: ['discussion'],
};

const STYLE = `You write briefings for a busy, technical reader who is deciding which Hacker News posts are worth opening.
Be concrete and neutral. No hype, no filler, no "This article…" openers. Plain sentences, no markdown.`;

const DISCUSSION_RULE = `discussion: ONE sentence (max 30 words) capturing what commenters are actually saying — the main agreement, pushback, or most useful insight. Empty string if there are fewer than 3 substantive comments.`;

function commentBlock(comments) {
  return comments.length ? comments.map((c, i) => `[${i + 1}] ${c}`).join('\n') : '(no comments yet)';
}

function mockStory(story) {
  return {
    summary: `Placeholder summary for “${story.title}”. Real summaries appear once the Gemini key is configured.`,
    tags: [story.title.startsWith('Show HN') ? 'Show HN' : story.title.startsWith('Ask HN') ? 'Ask HN' : 'Other'],
    discussion: story.comments >= 3 ? 'Placeholder: commenters are discussing the post.' : '',
    sourceAvailable: false,
  };
}

export async function summarizeStory({ apiKey, model, story, articleText, comments }) {
  if (process.env.MOCK_AI) return { value: mockStory(story), usage: {}, modelVersion: 'mock' };

  const prompt = `${STYLE}

Title: ${story.title}
Link: ${story.url ?? '(text post on Hacker News)'}
${story.text ? `Post text: ${story.text}\n` : ''}
Article text (may be truncated, noisy, or missing):
${articleText ?? '(could not be fetched — paywall, PDF, or blocked)'}

Top Hacker News comments:
${commentBlock(comments)}

Return JSON:
- summary: 2–3 sentences (max 60 words) saying what this actually is and why someone might care. If the article text is missing, work from the title, post text and comments, and keep it short.
- tags: 1–2 tags from the allowed list that best fit.
- ${DISCUSSION_RULE}
- sourceAvailable: true if the article/post text was usable, false otherwise.`;

  return generateJson({ apiKey, model, prompt, schema: STORY_SCHEMA });
}

export async function summarizeDiscussion({ apiKey, model, story, comments }) {
  if (process.env.MOCK_AI) return { value: { discussion: mockStory(story).discussion }, usage: {}, modelVersion: 'mock' };

  const prompt = `${STYLE}

Hacker News post: ${story.title}

Top comments:
${commentBlock(comments)}

Return JSON:
- ${DISCUSSION_RULE}`;

  return generateJson({ apiKey, model, prompt, schema: DISCUSSION_SCHEMA });
}
