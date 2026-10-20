// The panel under the menu bar icon: the servers by project, a kill button on each.
// The backend (src/backend/main.js) pushes a fresh list after every scan, shown or not.
const RELEASES_URL = 'https://github.com/adolfoflores/tiny-killer/releases/tag/v';

const columns = document.querySelector('#columns');
const list = document.querySelector('#list');
const summary = document.querySelector('#summary');
const refreshButton = document.querySelector('#refresh');
const killAllButton = document.querySelector('#killAll');
const rowTemplate = document.querySelector('#serverRow');
const quietTemplate = document.querySelector('#quietState');

const stopping = new Set(); // PIDs on their way out
const errors = new Map(); // PID -> why it survived, shown for a while
let state = { searching: true, count: 0, summary: null, groups: [] };
let shape = ''; // the groups and PIDs on screen; the rows are rebuilt only when it changes
// Kill all asks for a second click before it fires, on the servers listed when it
// was first clicked: { pids, timer }
let armed = null;

const listedPids = () => state.groups.flatMap((g) => g.servers.map((s) => s.pid));

function render(next) {
  state = next;
  summary.textContent = next.summary || (next.searching ? 'Scanning…' : 'Nothing running');
  killAllButton.disabled = next.count === 0;
  if (next.count === 0) disarm();

  const nextShape = JSON.stringify([next.searching, next.groups.map((g) => [g.key, g.servers.map((s) => s.pid)])]);
  if (nextShape !== shape) {
    shape = nextShape;
    build(next);
  }
  update(next);
  fitWindow();
}

function build(next) {
  list.replaceChildren();
  columns.hidden = next.groups.length === 0;
  if (next.groups.length === 0) {
    list.append(quiet(next.searching));
    return;
  }
  for (const group of next.groups) {
    const section = document.createElement('section');
    section.className = 'group';
    const heading = document.createElement('h2');
    heading.append(textSpan('project', group.project));
    if (group.worktree) heading.append(textSpan('worktree', `› ${group.worktree}`));
    if (group.servers.length > 1) heading.append(textSpan('count', String(group.servers.length)));
    const rows = document.createElement('ul');
    for (const server of group.servers) {
      const row = rowTemplate.content.firstElementChild.cloneNode(true);
      row.dataset.pid = server.pid;
      row.querySelector('.kill').addEventListener('click', () => kill(server.pid));
      rows.append(row);
    }
    section.append(heading, rows);
    list.append(section);
  }
}

// Numbers change on every scan; they are written into the rows already on screen
function update(next) {
  for (const server of next.groups.flatMap((g) => g.servers)) {
    const row = list.querySelector(`[data-pid="${server.pid}"]`);
    if (!row) continue;
    row.title = server.details; // kind, PID, CPU, folder and the whole command line
    row.querySelector('.port').textContent = server.ports;
    row.querySelector('.command').textContent = server.command;
    row.querySelector('.memory').textContent = server.memory;
    row.querySelector('.uptime').textContent = server.uptime;

    const isStopping = stopping.has(server.pid);
    const button = row.querySelector('.kill');
    row.classList.toggle('is-stopping', isStopping);
    button.disabled = isStopping;
    button.setAttribute('aria-label', isStopping ? `Stopping ${server.ports}` : `Kill ${server.ports}`);
    row.querySelector('.error').textContent = errors.get(server.pid) || '';
  }
}

function textSpan(className, text) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

function quiet(searching) {
  const block = quietTemplate.content.firstElementChild.cloneNode(true);
  block.querySelector('strong').textContent = searching ? 'Looking for dev servers…' : 'All quiet';
  block.querySelector('.hint').textContent = searching ? 'One moment.' : 'No dev servers are listening right now.';
  return block;
}

function showError(pid, message) {
  errors.set(pid, message);
  update(state);
  setTimeout(() => {
    errors.delete(pid);
    update(state);
  }, 6000);
}

// Ask the backend to kill; whatever happens, the rows stop saying "Stopping…"
async function killing(pids, call) {
  for (const pid of pids) {
    stopping.add(pid);
    errors.delete(pid);
  }
  update(state);
  let result;
  try {
    result = await call();
  } catch (error) {
    result = { ok: false, error: String(error?.message || error) };
  } finally {
    for (const pid of pids) stopping.delete(pid);
  }
  // A kill that worked has already pushed the list without them
  if (!result.ok) for (const pid of pids) showError(pid, result.error);
  update(state);
}

function kill(pid) {
  return killing([pid], () => tiny.api.call('killServer', { pid }));
}

function arm(pids, { untilClosed = false } = {}) {
  disarm();
  armed = { pids, timer: untilClosed ? null : setTimeout(disarm, 3000) };
  killAllButton.classList.add('is-armed');
  killAllButton.textContent = pids.length === 1 ? 'Kill 1 server?' : `Kill ${pids.length} servers?`;
}

function disarm() {
  if (armed) clearTimeout(armed.timer);
  armed = null;
  killAllButton.classList.remove('is-armed');
  killAllButton.textContent = 'Kill all';
}

killAllButton.addEventListener('click', () => {
  if (!armed) {
    arm(listedPids());
    return;
  }
  const { pids } = armed;
  disarm();
  killing(pids, () => tiny.api.call('killAll', { pids }));
});

async function refresh() {
  refreshButton.classList.add('is-busy');
  refreshButton.disabled = true;
  try {
    await tiny.api.call('refresh');
  } finally {
    refreshButton.classList.remove('is-busy');
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', refresh);
document.querySelector('#settings').addEventListener('click', () => tiny.api.call('openSettings'));
document.querySelector('#quit').addEventListener('click', () => tiny.api.call('quit'));

// The same keys as the menu, plus Escape to put the panel away
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') tiny.api.call('closePanel');
  else if (event.metaKey && event.key === 'r') {
    event.preventDefault();
    refresh();
  } else if (event.metaKey && event.key === ',') {
    event.preventDefault();
    tiny.api.call('openSettings');
  }
});

// The window takes the height of the panel; the list scrolls past its maximum
function fitWindow() {
  const height = Math.ceil(document.querySelector('.panel').getBoundingClientRect().height);
  if (height !== window.innerHeight) tiny.win.setSize(window.innerWidth, height);
}

// The window is kept between uses: each time it shows again, start it fresh
tiny.api.on('panel-shown', () => {
  disarm();
  list.scrollTop = 0;
  const panel = document.querySelector('.panel');
  panel.classList.remove('arrive');
  void panel.offsetWidth; // restart the animation
  panel.classList.add('arrive');
});

// Kill all from the menu: armed on the servers listed then, until the panel goes
// away; Return confirms it, Escape closes the panel
tiny.api.on('arm-kill-all', ({ pids }) => {
  arm(pids, { untilClosed: true });
  killAllButton.focus();
});

// A kill from the menu that didn't work: the row says why
tiny.api.on('kill-error', ({ pid, error }) => showError(pid, error));

// A newer version, found by the backend's daily check or by Settings
const updateBox = document.querySelector('#update');
const updateText = document.querySelector('#updateText');
const updateInstall = document.querySelector('#updateInstall');
let offeredUpdate = null;

function showUpdate(info) {
  offeredUpdate = info;
  updateBox.hidden = !info;
  if (info) {
    updateText.textContent = `Version ${info.latest} is available`;
    updateText.classList.remove('is-error');
    updateInstall.disabled = false;
    updateInstall.textContent = 'Update';
  }
  fitWindow();
}

document.querySelector('#updateNotes').addEventListener('click', () => {
  if (offeredUpdate) tiny.app.shell.open(RELEASES_URL + offeredUpdate.latest);
});

updateInstall.addEventListener('click', async () => {
  updateInstall.disabled = true;
  updateInstall.textContent = 'Updating…';
  try {
    await tiny.api.call('installUpdate'); // the app relaunches as the new version
  } catch (error) {
    updateText.textContent = `Couldn't update: ${error?.message || error}`;
    updateText.classList.add('is-error');
    updateInstall.disabled = false;
    updateInstall.textContent = 'Try again';
    fitWindow();
  }
});

tiny.api.on('update', showUpdate);
tiny.api.call('getUpdate').then(showUpdate);

tiny.api.on('servers', render);
tiny.api.call('getServers').then(render);
