import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenu, buildPanel } from '../src/backend/menu.js';

const stats = (mb) => ({ cpu: 0, rssKb: 0, memoryKb: mb * 1024, elapsedSeconds: 16 });
const server = (pid, port, project, type = 'node') => ({
  pid,
  type,
  ports: [port],
  commandLine: `node server.js ${port}`,
  stats: stats(14),
  project: project && { project, worktree: null },
});

// What the menu shows, one line per item, as it reads on screen
const lines = (items) => items.map((item) => (item.separator ? '──' : `${item.label}${item.enabled === false ? ' (off)' : ''}${item.key ? ` ⌘${item.key.toUpperCase()}` : ''}`));

test('buildMenu groups servers under their project, with a summary on top', () => {
  const items = buildMenu([server(11, 3101, 'api'), server(12, 3102, 'api'), server(13, 4100, 'shop', 'bun'), server(14, 8099, null)]);
  assert.deepEqual(lines(items), [
    '4 servers · 56 MB (off)',
    '──',
    'api (off)',
    '\u2003⬢ :3101 — server.js 3101 · 0% · 14 MB · 16s',
    '\u2003⬢ :3102 — server.js 3102 · 0% · 14 MB · 16s',
    'shop (off)',
    '\u2003⬥ :4100 — server.js 4100 · 0% · 14 MB · 16s',
    'Other (off)',
    '\u2003⬢ :8099 — server.js 8099 · 0% · 14 MB · 16s',
    '──',
    'Kill all (4)',
    'Refresh ⌘R',
    'Settings… ⌘,',
    'Quit Tiny Killer ⌘Q',
  ]);
  // A click on a server kills it
  assert.deepEqual(items.filter((item) => item.id?.startsWith('kill:')).map((item) => item.id), ['kill:11', 'kill:12', 'kill:13', 'kill:14']);
});

test('buildMenu says so when nothing is running, or when it has not looked yet', () => {
  assert.deepEqual(lines(buildMenu([])), [
    'All quiet — no dev servers running (off)',
    '──',
    'Kill all (0) (off)',
    'Refresh ⌘R',
    'Settings… ⌘,',
    'Quit Tiny Killer ⌘Q',
  ]);
  assert.equal(buildMenu([], { searching: true })[0].label, 'Looking for dev servers…');
});

test('buildPanel gives the page the same groups as plain values', () => {
  const big = { ...server(13, 4100, 'shop', 'bun'), stats: stats(56), cwd: '/x/shop' };
  const panel = buildPanel([server(11, 3101, 'api'), big, server(14, 8099, null)]);
  assert.equal(panel.count, 3);
  assert.equal(panel.summary, '3 servers · 84 MB');
  assert.deepEqual(panel.groups.map((g) => [g.project, g.servers.map((s) => s.pid)]), [['api', [11]], ['shop', [13]], ['Other', [14]]]);
  assert.deepEqual(panel.groups[1].servers[0], {
    pid: 13, ports: ':4100', command: 'server.js 4100', memory: '56 MB', uptime: '16s',
    details: 'bun · PID 13 · CPU 0%\n/x/shop\nnode server.js 4100',
  });
  assert.deepEqual(buildPanel([], { searching: true }), { searching: true, count: 0, summary: null, groups: [] });
});
