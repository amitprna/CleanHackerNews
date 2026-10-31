'use strict';

const PASS_KEY = 'hnbrief.passphrase';
const ARCHIVE_KEY = 'hnbrief.archive';
const META_KEY = 'hnbrief.archiveMeta';
const SHOW_DAYS = 3; // the Archive tab shows the last 3 days; older entries are deleted
const SKIP_KEY = 'hnbrief.skipSync';
const THEME_KEY = 'hnbrief.theme';
const RELOAD_AFTER_MS = 5 * 60 * 1000;
const TOAST_MS = 3000;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const saved = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

const state = {
  stories: [],
  updatedAt: 0,
  windowDays: 7,
  archive: new Map(readLocalArchive()), // story id -> archivedAt
  meta: new Map(readLocal(META_KEY)), // story id -> what the Archive tab shows
  view: 'inbox',
  tag: null,
  pass: saved.get(PASS_KEY),
  synced: false,
  loadedAt: 0,
  firstPaint: true,
  undo: null,
};

const $ = (id) => document.getElementById(id);

/** Tiny element builder; strings become text nodes, so nothing is ever parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup; // constant icon markup only, never data
  return t.content.firstChild;
}

// ---------- Formatting ----------

function ago(ms, suffix = ' ago') {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m${suffix}`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${suffix}`;
  return `${Math.floor(s / 86400)}d${suffix}`;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

const hnUrl = (id) => `https://news.ycombinator.com/item?id=${id}`;
const userUrl = (name) => `https://news.ycombinator.com/user?id=${encodeURIComponent(name)}`;
const linkOf = (s) => s.url || hnUrl(s.id);

const TAG_ICON = {
  AI: '🤖', Programming: '💻', Security: '🔐', Startups: '🚀', Business: '💼', Science: '🔬',
  Hardware: '🔧', Web: '🌐', 'Open Source': '🧩', Policy: '⚖️', Design: '🎨', Culture: '🎭',
  'Show HN': '📣', 'Ask HN': '💬', Other: '✨',
};
const TAG_HUE = {
  AI: 265, Programming: 210, Security: 350, Startups: 25, Business: 45, Science: 160,
  Hardware: 190, Web: 230, 'Open Source': 130, Policy: 0, Design: 315, Culture: 290,
  'Show HN': 15, 'Ask HN': 180, Other: 60,
};

// ---------- Theme ----------

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'Theme: match my device', light: 'Theme: light', dark: 'Theme: dark' };

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : 'system';
}

function applyTheme(theme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
    saved.del(THEME_KEY);
  } else {
    document.documentElement.dataset.theme = theme;
    saved.set(THEME_KEY, theme);
  }
  const btn = $('theme');
  btn.dataset.mode = theme;
  btn.title = `${THEME_LABEL[theme]}. Click to change.`;
  btn.setAttribute('aria-label', THEME_LABEL[theme]);
}

$('theme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  const swap = () => applyTheme(next);
  if (document.startViewTransition && !REDUCED_MOTION) document.startViewTransition(swap);
  else swap();
});
applyTheme(currentTheme());

// ---------- Archive: local first, synced when a passphrase is set ----------

function readLocal(key) {
  try { return Object.entries(JSON.parse(localStorage.getItem(key) || '{}')); } catch { return []; }
}
function readLocalArchive() {
  return readLocal(ARCHIVE_KEY).filter(([, t]) => Number.isFinite(t));
}

const showCutoff = () => Date.now() - SHOW_DAYS * 86_400_000;

function saveLocalArchive() {
  const cutoff = Date.now() - 9 * 86_400_000;
  saved.set(ARCHIVE_KEY, JSON.stringify(Object.fromEntries([...state.archive].filter(([, t]) => t > cutoff))));
  for (const id of state.meta.keys()) if (!(state.archive.get(id) > showCutoff())) state.meta.delete(id);
  saved.set(META_KEY, JSON.stringify(Object.fromEntries(state.meta)));
}

/** The fields the Archive tab needs, saved with the archive so they outlive the story's place in the list. */
function metaOf(s) {
  const { title, url, author, points, comments, createdAt, summary, tags } = s;
  return { title, url, author, points, comments, createdAt, summary: summary ?? undefined, tags };
}

class UnknownPassphrase extends Error {}
class TakenPassphrase extends Error {}

async function api(method, path, body, pass = state.pass) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-hn-passphrase': pass ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && path === '/me' && method === 'GET') throw new UnknownPassphrase();
  if (res.status === 409) throw new TakenPassphrase();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let writes = Promise.resolve();
/** Sync writes run one at a time so an Undo can never overtake its archive. */
function push(change) {
  saveLocalArchive();
  if (!state.pass) return;
  const p = writes.then(() => api('POST', '/archive', change));
  writes = p.catch(() => {});
  p.catch(() => toast('Couldn’t sync that. It’s saved on this device and will sync next time.'));
}

/** Merge the server's list with this device's, then send up anything only this device knew. */
async function syncArchive(pass) {
  const { archive, meta = {} } = await api('GET', '/me', null, pass);
  const localOnly = [...state.archive.keys()].filter((id) => !(id in archive));
  for (const [id, t] of Object.entries(archive)) state.archive.set(id, t);
  for (const [id, m] of Object.entries(meta)) state.meta.set(id, m);
  if (localOnly.length) {
    const localMeta = Object.fromEntries(localOnly.filter((id) => state.meta.has(id)).map((id) => [id, state.meta.get(id)]));
    await api('POST', '/archive', { add: localOnly, meta: localMeta }, pass);
  }
  saveLocalArchive();
  state.synced = true;
}

async function loadStories() {
  const res = await fetch('/data/stories.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`stories: HTTP ${res.status}`);
  const data = await res.json();
  state.stories = data.stories ?? [];
  state.updatedAt = data.updatedAt ?? 0;
  state.windowDays = data.windowDays ?? 7;
}

async function loadAll() {
  state.loadedAt = Date.now();
  const [stories, sync] = await Promise.allSettled([loadStories(), state.pass ? syncArchive(state.pass) : null]);
  if (sync.status === 'rejected') {
    if (sync.reason instanceof UnknownPassphrase) {
      // A passphrase saved on this device but unknown to the server: claim it, keeping this device's list.
      try {
        await api('POST', '/me', { archive: Object.fromEntries(state.archive), meta: Object.fromEntries(state.meta) });
        state.synced = true;
      } catch {
        state.pass = null;
        saved.del(PASS_KEY);
        openWelcome('signin', 'That passphrase isn’t known any more. Enter it again or pick a new one.');
      }
    } else toast('Couldn’t reach the sync server, so stories read elsewhere may show up.');
  }
  if (stories.status === 'rejected') toast('Couldn’t load stories. Try again in a minute.');
  render();
}

// ---------- Actions ----------

/** FLIP: remember where every card is, change the DOM, then glide them to their new spots. */
function withFlip(change) {
  const before = new Map([...document.querySelectorAll('.story')].map((el) => [el.dataset.id, el.getBoundingClientRect()]));
  change();
  if (REDUCED_MOTION) return;
  for (const el of document.querySelectorAll('.story')) {
    const old = before.get(el.dataset.id);
    if (!old) continue;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (!dx && !dy) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.2, .9, .25, 1.05)' });
  }
}

function leave(id) {
  const row = document.querySelector(`.story[data-id="${id}"]`);
  if (!row || REDUCED_MOTION) return Promise.resolve();
  row.classList.add('leaving');
  const anim = row.animate(
    [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateX(48px) scale(.96) rotate(1.5deg)', filter: 'blur(2px)' }],
    { duration: 240, easing: 'cubic-bezier(.4, 0, .7, .2)', fill: 'forwards' },
  ).finished.catch(() => {});
  // Background tabs may never finish an animation; don't let that block the archive.
  return Promise.race([anim, new Promise((r) => setTimeout(r, 300))]);
}

async function archiveStory(story, reason) {
  if (state.archive.has(story.id)) return;
  await leave(story.id);
  state.archive.set(story.id, Date.now());
  state.meta.set(story.id, metaOf(story));
  withFlip(render);
  push({ add: [story.id], meta: { [story.id]: state.meta.get(story.id) } });
  state.undo = () => restore(story.id);
  toast(reason === 'read' ? 'Marked as read' : 'Archived', state.undo);
}

async function restore(id, { fromArchive = false } = {}) {
  if (!state.archive.has(id)) return;
  if (fromArchive) await leave(id);
  const prev = { at: state.archive.get(id), meta: state.meta.get(id) };
  state.archive.delete(id);
  state.meta.delete(id);
  state.undo = null;
  withFlip(render);
  const row = document.querySelector(`.story[data-id="${id}"]`);
  row?.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'ease-out' });
  push({ remove: [id] });
  if (fromArchive) {
    state.undo = () => {
      state.archive.set(id, prev.at);
      if (prev.meta) state.meta.set(id, prev.meta);
      withFlip(render);
      push({ add: [id], meta: prev.meta ? { [id]: prev.meta } : {} });
    };
    toast('Back in your stories', state.undo);
  }
}

// ---------- Rendering ----------

const ARCHIVE_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h14M4.5 5.5v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-9M8 9.5h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 9a6 6 0 1 1 1.8 4.3M4 4.5V9h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const COMMENT_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

function storyCard(s, index, maxPoints, archivedAt = null) {
  const domain = s.url ? domainOf(s.url) : 'news.ycombinator.com';
  const markRead = (e) => {
    if (archivedAt || (e.type === 'auxclick' && e.button !== 1)) return;
    archiveStory(s, 'read');
  };
  const points = s.points ?? 0;
  const comments = s.comments ?? 0;
  const pct = maxPoints ? Math.max(4, Math.round((points / maxPoints) * 100)) : 0;
  const lead = !archivedAt && index === 0 && !state.tag;

  const summary = s.summary
    ? h('p', { class: 'summary' }, s.summary,
        s.sourceAvailable === false
          ? h('span', { class: 'note', title: 'The article couldn’t be fetched, so this is based on the title and comments.' }, ' · from the thread')
          : null)
    : archivedAt ? null : h('p', { class: 'summary pending' }, 'Summary on its way. It will appear after the next hourly refresh.');

  return h('li', {
    class: ['story', lead && 'lead'].filter(Boolean).join(' '),
    'data-id': s.id,
    style: `--i:${Math.min(index, 14)}`,
  },
    h('div', { class: 'score', title: `${points.toLocaleString()} points` },
      h('span', { class: 'rank' }, String(index + 1).padStart(2, '0')),
      h('span', { class: 'pts', 'data-count': points }, state.firstPaint && !REDUCED_MOTION && index < 12 ? '0' : points.toLocaleString()),
      h('span', { class: 'pts-label' }, 'points'),
      h('span', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${pct}%` }))),
    h('div', { class: 'story-body' },
      h('p', { class: 'kicker' },
        domain ? h('span', { class: 'domain' }, domain) : null,
        h('span', { class: 'age' }, archivedAt ? `archived ${ago(archivedAt)}` : ago(s.createdAt * 1000)),
        s.author ? h('a', { class: 'author', href: userUrl(s.author), target: '_blank', rel: 'noopener', title: `${s.author} on Hacker News` }, s.author) : null),
      h('h2', { class: 'title' },
        h('a', { href: linkOf(s), target: '_blank', rel: 'noopener', onclick: markRead, onauxclick: markRead }, s.title)),
      summary,
      s.discussion ? h('div', { class: 'thread' }, h('span', { class: 'thread-label' }, 'The thread'), h('p', {}, s.discussion)) : null,
      h('div', { class: 'foot' },
        archivedAt
          ? h('button', { class: 'action', type: 'button', onclick: () => restore(s.id, { fromArchive: true }) }, svg(RESTORE_ICON), h('span', {}, 'Restore'))
          : h('button', { class: 'action', type: 'button', onclick: () => archiveStory(s, 'skipped') }, svg(ARCHIVE_ICON), h('span', {}, 'Archive')),
        s.tags?.length ? h('span', { class: 'tags' }, s.tags.map((t) => h('span', { class: 'tag', style: `--hue:${TAG_HUE[t] ?? 25}` }, h('span', { class: 'emoji', 'aria-hidden': 'true' }, TAG_ICON[t] ?? '✨'), t))) : null,
        h('a', { class: 'comments', href: hnUrl(s.id), target: '_blank', rel: 'noopener' },
          svg(COMMENT_ICON), h('span', {}, comments.toLocaleString()), h('span', { class: 'comments-word' }, comments === 1 ? ' comment' : ' comments')))),
    h('span', { class: 'sheen', 'aria-hidden': 'true' }));
}

function renderRail(top, list) {
  if (state.updatedAt) {
    const next = Math.round((state.updatedAt + 3_600_000 - Date.now()) / 60000);
    $('refresh').replaceChildren(h('span', { class: 'live', 'aria-hidden': 'true' }),
      `Updated ${ago(state.updatedAt)} · ${next > 0 ? `next in ${next}m` : 'refresh due'}`);
  }

  $('sync').replaceChildren(state.pass
    ? h('span', {}, h('span', { class: 'sync-dot ok', 'aria-hidden': 'true' }), state.synced ? 'Synced across your devices' : 'Syncing…')
    : h('span', {}, h('span', { class: 'sync-dot', 'aria-hidden': 'true' }), 'Only on this device · ', h('u', {}, 'Sync')));

  const counts = new Map();
  for (const s of list) for (const t of s.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  if (state.tag && !counts.has(state.tag)) state.tag = null;
  const topics = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('tags').replaceChildren(
    ...[[null, list.length], ...topics].map(([t, n]) =>
      h('button', {
        class: 'topic', type: 'button', 'aria-pressed': String(state.view === 'inbox' && state.tag === t), style: `--hue:${TAG_HUE[t] ?? 25}`,
        onclick: () => { state.view = 'inbox'; state.tag = t; withFlip(render); window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' }); },
      }, h('span', { class: 'emoji', 'aria-hidden': 'true' }, t ? TAG_ICON[t] ?? '✨' : '📰'), h('span', {}, t ?? 'All stories'), h('span', { class: 'n' }, String(n)))),
  );

  const tab = $('archive-tab');
  tab.setAttribute('aria-pressed', String(state.view === 'archive'));
  tab.replaceChildren(h('span', { class: 'emoji', 'aria-hidden': 'true' }, '🗄️'), h('span', {}, 'Archive'), h('span', { class: 'n' }, String(archivedRecently().length)));
}

/** Stories archived in the last 3 days, newest first, with whatever we know about each. */
function archivedRecently() {
  const byId = new Map(state.stories.map((s) => [s.id, s]));
  return [...state.archive]
    .filter(([, t]) => t > showCutoff())
    .sort((a, b) => b[1] - a[1])
    .map(([id, t]) => {
      const s = byId.get(id) ?? (state.meta.has(id) ? { id, ...state.meta.get(id) } : null);
      return s && { story: s, at: t };
    })
    .filter(Boolean);
}

function render() {
  const top = state.stories.filter((s) => !state.archive.has(s.id));
  renderRail(top, top);
  if (state.view === 'archive') return renderArchive();

  const shown = state.tag ? top.filter((s) => s.tags?.includes(state.tag)) : top;
  $('feed-eyebrow').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('feed-title').textContent = state.tag ? `${TAG_ICON[state.tag] ?? ''} ${state.tag}`.trim() : 'The week on Hacker News';

  const maxPoints = Math.max(0, ...state.stories.map((s) => s.points));
  $('stories').classList.toggle('intro', state.firstPaint && !REDUCED_MOTION);
  $('stories').replaceChildren(
    ...(shown.length
      ? shown.map((s, i) => storyCard(s, i, maxPoints))
      : [h('li', { class: 'empty' },
          h('span', { class: 'empty-art', 'aria-hidden': 'true' }, state.stories.length ? '🎉' : '☕'),
          h('strong', {}, state.stories.length ? 'Inbox zero' : 'No stories yet'),
          h('span', {}, state.stories.length ? 'You’re all caught up. New stories arrive every hour.' : 'The first refresh is on its way.'))]),
  );
  if (state.firstPaint && state.stories.length) {
    state.firstPaint = false;
    countUp();
  }
}

function renderArchive() {
  const items = archivedRecently();
  $('feed-eyebrow').textContent = 'Last 3 days';
  $('feed-title').textContent = 'Archive';
  const maxPoints = Math.max(0, ...state.stories.map((s) => s.points));
  $('stories').classList.remove('intro');
  $('stories').replaceChildren(
    ...(items.length
      ? items.map(({ story, at }, i) => storyCard(story, i, maxPoints, at))
      : [h('li', { class: 'empty' },
          h('span', { class: 'empty-art', 'aria-hidden': 'true' }, '🗄️'),
          h('strong', {}, 'Nothing archived lately'),
          h('span', {}, 'Stories you open or archive stay here for 3 days.'))]),
  );
}

$('archive-tab').addEventListener('click', () => {
  state.view = state.view === 'archive' ? 'inbox' : 'archive';
  withFlip(render);
  window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
});

/** Points tick up from zero on the first paint. */
function countUp() {
  const els = [...document.querySelectorAll('.pts[data-count]')].slice(0, 12);
  if (REDUCED_MOTION || !els.length) return;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 900);
    const e = 1 - (1 - t) ** 3;
    for (const el of els) el.textContent = Math.round(Number(el.dataset.count) * e).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let toastTimer;
function toast(message, undo) {
  const el = $('toast');
  el.replaceChildren(h('span', {}, message), ...(undo
    ? [h('button', { type: 'button', onclick: () => { el.classList.remove('show'); state.undo = null; undo(); } }, 'Undo')]
    : []));
  el.classList.remove('show');
  void el.offsetWidth; // restart the countdown bar
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); state.undo = null; }, TOAST_MS);
}

// ---------- The hover glow follows the pointer ----------

let glowFrame = 0;
document.addEventListener('pointermove', (e) => {
  if (REDUCED_MOTION || e.pointerType !== 'mouse') return;
  const card = e.target.closest?.('.story');
  if (!card) return;
  cancelAnimationFrame(glowFrame);
  glowFrame = requestAnimationFrame(() => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
    card.style.setProperty('--my', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
  });
}, { passive: true });

// ---------- Welcome: create or enter a passphrase ----------

let welcomeMode = 'create';
const WELCOME_COPY = {
  create: { title: 'Welcome to HN Brief', go: 'Create my passphrase', text: 'Pick a passphrase to remember what you’ve read. Type it on any other device and stories you’ve finished stay gone.' },
  signin: { title: 'Welcome back', go: 'Continue', text: 'Enter the passphrase you picked before, and this device will skip everything you’ve already read.' },
};

function setWelcomeMode(mode) {
  welcomeMode = mode;
  const c = WELCOME_COPY[mode];
  $('welcome-title').textContent = c.title;
  $('welcome-text').textContent = c.text;
  $('welcome-go').textContent = c.go;
  $('welcome-error').textContent = '';
  for (const b of document.querySelectorAll('.segmented [data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
}

function openWelcome(mode = 'create', error = '') {
  setWelcomeMode(mode);
  $('welcome-error').textContent = error;
  $('pass').value = '';
  if (!$('welcome').open) $('welcome').showModal();
  $('pass').focus();
}

for (const b of document.querySelectorAll('.segmented [data-mode]')) b.addEventListener('click', () => { setWelcomeMode(b.dataset.mode); $('pass').focus(); });

$('welcome-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('pass').value.trim();
  if (pass.length < 6) { $('welcome-error').textContent = 'Use at least 6 characters.'; return; }
  const button = $('welcome-go');
  button.disabled = true;
  $('welcome-error').textContent = '';
  try {
    if (welcomeMode === 'create') {
      await api('POST', '/me', { archive: Object.fromEntries(state.archive), meta: Object.fromEntries(state.meta) }, pass);
      state.synced = true;
    } else {
      await syncArchive(pass);
    }
    state.pass = pass;
    saved.set(PASS_KEY, pass);
    saved.del(SKIP_KEY);
    $('welcome').close();
    withFlip(render);
    toast(welcomeMode === 'create' ? 'You’re set. Use this passphrase on your other devices.' : 'Synced. Stories you’ve read are gone.');
  } catch (err) {
    $('welcome-error').textContent =
      err instanceof TakenPassphrase ? 'Someone already uses that one. Pick another, or choose “I have one” if it’s yours.'
      : err instanceof UnknownPassphrase ? 'No one has picked that passphrase yet. Check it, or choose “I’m new”.'
      : 'Couldn’t reach the server. Check your connection.';
  } finally {
    button.disabled = false;
  }
});

$('welcome-skip').addEventListener('click', () => { saved.set(SKIP_KEY, '1'); $('welcome').close(); });
$('sync').addEventListener('click', () => { if (!state.pass) openWelcome('create'); });

// ---------- Start ----------

// Pick up new stories (and archive changes from other devices) when coming back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > RELOAD_AFTER_MS) loadAll();
});
setInterval(() => {
  if (state.updatedAt && document.visibilityState === 'visible') {
    const top = state.stories.filter((s) => !state.archive.has(s.id));
    renderRail(top, top);
  }
}, 60_000);

loadAll();
if (!state.pass && !saved.get(SKIP_KEY)) setTimeout(() => openWelcome('create'), 700);
