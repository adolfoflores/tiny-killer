// ⚡️ Tiny Killer: a macOS menu bar app that finds your Node.js, Vite and Bun dev
// servers (anything listening on a TCP port) and kills them with a click.
// Runs on tinyjs: a txiki.js backend (this file) and the system WebKit for the panel
// and the Settings window.

import path from 'tjs:path';
import {
  PROCESS_TYPES,
  parseLsofOutputFields,
  parsePsOutput,
  parseFootprintOutput,
  classifyCommand,
  formatTrayTitle,
  parseProcessTable,
  planKill,
  parseLsofCwdOutput,
  describeProject,
  sortProcesses,
} from './scanner.js';
import { buildMenu, buildPanel } from './menu.js';
import * as prefs from './prefs.js';

// Absolute paths: an app opened from Finder gets a minimal PATH
const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const FOOTPRINT = '/usr/bin/footprint';

// LC_ALL=C keeps decimals as "3.5" regardless of the user's locale
const C_LOCALE = { ...tjs.env, LC_ALL: 'C' };
const DEBUG = tjs.env.TINYKILLER_DEBUG === '1';
const decoder = new TextDecoder();

let app = null;
let trayIcon = 'sf:bolt.fill'; // replaced by resources/tray.png when it ships
let refreshTimeout = null;
let latestProcesses = [];
let scanned = false; // until the first scan, the empty menu says it is still looking

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// tjs.spawn has no timeout: kill the child when it hangs, like execFile's `timeout`.
// The read races the timer because a pipe held open elsewhere would keep it waiting.
async function run(argv, { timeoutMs = 3000, env = undefined } = {}) {
  let child;
  try {
    child = tjs.spawn(argv, { stdout: 'pipe', stderr: 'ignore', ...(env ? { env } : {}) });
  } catch (err) {
    console.debug(`[${argv[0]}] spawn failed:`, err?.message || err);
    return { code: null, stdout: '' };
  }
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, timeoutMs);
  });
  const reading = child.stdout.text().catch(() => '');
  const stdout = await Promise.race([reading, timedOut]);
  clearTimeout(timer);
  if (stdout === null) {
    console.debug(`[${argv[0]}] timed out after ${timeoutMs} ms`);
    child.wait().catch(() => {}); // reap it
    return { code: null, stdout: '' };
  }
  const status = await child.wait().catch(() => null);
  return { code: status && !status.term_signal ? status.exit_status : null, stdout };
}

function readProcessTable() {
  // ps exits non-zero now and then but still prints the table
  return run([PS, '-Ao', 'pid=,ppid=,stat=,command='], { env: C_LOCALE }).then(({ stdout }) => parseProcessTable(stdout));
}

// Returns the PIDs that refused the signal for a reason other than being gone already
function signalAll(pids, signal) {
  const denied = [];
  for (const pid of pids) {
    // 0 and -1 would signal whole process groups; never ourselves
    if (!Number.isInteger(pid) || pid <= 1 || pid === tjs.pid) continue;
    try {
      tjs.kill(pid, signal);
    } catch (err) {
      if (err?.code === 'EPERM') denied.push(pid);
    }
  }
  return denied;
}

// txiki can't send signal 0 to probe a PID, so ps decides: a process still runs while
// it is listed and isn't a zombie (zombies are dead, they only wait to be reaped).
async function stillRunning(pids) {
  const table = await readProcessTable();
  if (table.size === 0) return { alive: pids, table }; // ps failed: assume nothing died
  return { alive: pids.filter((pid) => table.has(pid) && !table.get(pid).stat.startsWith('Z')), table };
}

// Wait up to `ms` for the processes to go, looking every 50 ms: most dev servers
// are gone well before a fixed wait would end
async function waitForExit(pids, ms) {
  const deadline = Date.now() + ms;
  let result = await stillRunning(pids);
  while (result.alive.length > 0 && Date.now() < deadline) {
    await sleep(50);
    result = await stillRunning(result.alive);
  }
  return result;
}

// Stop each server like Ctrl-C would: together with the dev runner that started it
// (npm, next dev, …) and every process they started. SIGTERM first, then SIGKILL.
// -> { ok, targets, error? }
async function killServers(serverPids) {
  const targets = planKill(await readProcessTable(), serverPids, tjs.pid);

  const denied = signalAll(targets, 'SIGTERM');
  let after = await waitForExit(targets, 500);
  if (after.alive.length === 0) return { ok: true, targets };

  signalAll(after.alive, 'SIGKILL');
  after = await waitForExit(after.alive, 300);
  const { alive } = after;
  if (alive.length === 0) return { ok: true, targets };

  let error = `${alive.length} process(es) still alive after SIGKILL (PID ${alive.join(', ')})`;
  if (alive.some((pid) => denied.includes(pid))) {
    error = `Permission denied for PID ${alive.join(', ')} (owned by another user)`;
  } else if (alive.some((pid) => (after.table.get(pid)?.stat || '').startsWith('U'))) {
    error = `PID ${alive.join(', ')} is stuck waiting on the disk or a driver; only a restart will free it`;
  }
  return { ok: false, targets, error };
}

// Every way to kill goes through here: only servers on the list (anything else is
// refused), and the list shows them gone as soon as they are. -> { ok, error }
async function killListed(pids) {
  const listed = new Set(latestProcesses.map((p) => p.pid));
  const wanted = (Array.isArray(pids) ? pids : []).filter((pid) => listed.has(pid));
  if (wanted.length === 0) return { ok: false, error: 'It is no longer running.' };

  const res = await killServers(wanted);
  killGen += 1; // a scan that started before this kill may still list them
  if (res.ok) {
    const gone = new Set(res.targets);
    latestProcesses = latestProcesses.filter((p) => !gone.has(p.pid));
    updateTray();
    refreshNow(); // behind, to catch anything else that changed
  } else {
    await refreshNow(); // to show what survived
  }
  return { ok: res.ok, error: res.error || null };
}

// One ps call for every PID: command line, CPU, memory and uptime
async function readProcessStats(pids) {
  if (pids.length === 0) return new Map();
  // ps exits 1 when a PID is already gone but still prints the others
  const { stdout } = await run([PS, '-o', 'pid=,pcpu=,rss=,etime=,command=', '-p', pids.join(',')], { env: C_LOCALE });
  return parsePsOutput(stdout);
}

// Scan for a specific process command (node or bun)
async function scanProcessCommand(processCommand) {
  // Only your own: without admin rights lsof can't see another account's sockets
  const filter = ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', processCommand, '-u', tjs.system.userInfo.userName];

  // Field format keeps the output small; lsof exits 1 when nothing matches
  const { code, stdout } = await run([LSOF, ...filter, '-F', 'pcPn'], { timeoutMs: 4000 });
  if (code !== 0 && code !== 1) console.debug(`[lsof ${processCommand}] failed with code ${code}`);
  return code === 0 ? parseLsofOutputFields(stdout, processCommand) : [];
}

// Memory as Activity Monitor reports it (ps RSS misses compressed memory on macOS)
async function readMemoryFootprints(pids) {
  if (pids.length === 0) return new Map();
  // A process footprint can't inspect is skipped; its RSS is used instead
  const { stdout } = await run([FOOTPRINT, ...pids.flatMap((pid) => ['-p', String(pid)])], { env: C_LOCALE });
  return parseFootprintOutput(stdout);
}

// Working folder of each process, with one lsof call
async function readWorkingDirs(pids) {
  if (pids.length === 0) return new Map();
  // lsof exits 1 when a PID is already gone but still prints the others
  const { stdout } = await run([LSOF, '-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
  return parseLsofCwdOutput(stdout);
}

// describeProject's disk access on txiki's async file calls
const fileIo = {
  path,
  stat: (file) => tjs.stat(file).then((s) => ({ isFile: s.isFile, isDirectory: s.isDirectory }), () => null),
  readText: (file) => tjs.readFile(file).then((bytes) => decoder.decode(bytes), () => null),
};

// pid + command line -> { cwd, project }. A dev server rarely changes folder, so each
// process is looked up once; entries go away when the process does.
const projectCache = new Map();

async function lookUpProjects(procs) {
  const keyOf = (p) => `${p.pid}\0${p.commandLine}`;
  const liveKeys = new Set(procs.map(keyOf));
  for (const key of projectCache.keys()) {
    if (!liveKeys.has(key)) projectCache.delete(key);
  }

  const missing = procs.filter((p) => !projectCache.has(keyOf(p)));
  if (missing.length > 0) {
    const cwdByPid = await readWorkingDirs(missing.map((p) => p.pid));
    for (const p of missing) {
      const cwd = cwdByPid.get(p.pid) || null;
      // Not cached when lsof gave no folder, so it is tried again on the next refresh
      if (cwd) projectCache.set(keyOf(p), { cwd, project: await describeProject(cwd, tjs.homeDir, fileIo) });
    }
  }
  return procs.map((p) => ({ ...p, ...(projectCache.get(keyOf(p)) || { cwd: null, project: null }) }));
}

// Main function to scan for all enabled process types
async function scanProcessListeners() {
  const enabledTypes = prefs.getProcessTypes();

  // Determine which lsof commands we need to run
  const lsofCommands = new Set();
  for (const [typeName, enabled] of Object.entries(enabledTypes)) {
    if (enabled && PROCESS_TYPES[typeName]) {
      lsofCommands.add(PROCESS_TYPES[typeName].lsofCommand);
    }
  }

  // Run lsof for each unique command, skipping PIDs already seen
  const listeners = [];
  const seenPids = new Set();
  for (const lsofCommand of lsofCommands) {
    for (const listener of await scanProcessCommand(lsofCommand)) {
      if (seenPids.has(listener.pid)) continue;
      seenPids.add(listener.pid);
      listeners.push({ ...listener, lsofCommand });
    }
  }

  const pids = listeners.map((p) => p.pid);
  const [statsByPid, memoryKbByPid] = await Promise.all([readProcessStats(pids), readMemoryFootprints(pids)]);

  const allProcesses = [];
  for (const { lsofCommand, ...listener } of listeners) {
    const psStats = statsByPid.get(listener.pid);
    const stats = psStats ? { ...psStats, memoryKb: memoryKbByPid.get(listener.pid) } : null;
    const commandLine = stats ? stats.commandLine : '';
    const processType = classifyCommand(commandLine, lsofCommand);

    // Only include if this type is enabled
    if (enabledTypes[processType]) {
      allProcesses.push({ ...listener, type: processType, commandLine, stats });
    }
  }

  return sortProcesses(await lookUpProjects(allProcesses));
}

// The status item: a left click opens the panel, a right click the native menu. The
// panel's page gets every new list too, so it is current the moment it shows.
let lastTraySpec = '';

function updateTray() {
  const mode = prefs.getDisplayMode();
  const menu = buildMenu(latestProcesses, { searching: !scanned });
  const spec = {
    title: formatTrayTitle(mode, latestProcesses),
    icon: mode === 'icon-only' ? trayIcon : '',
    tooltip: `Tiny Killer — active processes: ${latestProcesses.length}`,
    menu,
    primaryAction: true,
  };
  // The launcher rebuilds the whole menu on every set: skip it when nothing changed
  const key = JSON.stringify(spec);
  if (key !== lastTraySpec) {
    lastTraySpec = key;
    app.tray.set(spec);
    if (DEBUG) console.log(menu.map((item) => (item.separator ? '──' : item.label)).join('\n'));
  }
  app.window('main').push('servers', panelState());
}

// The panel under the icon is the app's main window (src/frontend/index.html), on the
// popover material, and it goes away when it loses focus. In accessory mode tinyjs
// builds that window hidden at launch and loads its page behind, so a click only
// places and shows it. That holds about 50 MB of WebKit memory, the price of opening
// at once.
const PANEL_WIDTH = 360; // as "size" in tinyjs.json
const PANEL_GAP = 6;
const REOPEN_GUARD_MS = 600;
let panelOpen = false;
let panelOpening = false;
let panelFocused = false; // it shows unfocused; only losing focus after having it closes it
let panelBlurredAt = 0;
let settingsOpen = false;

function panelState() {
  return buildPanel(latestProcesses, { searching: !scanned });
}

// Where the panel goes: under the icon, inside the screen it is on
async function panelPlace() {
  const [spot, mouse, screenList] = await Promise.all([app.tray.position(), app.mousePosition(), app.screens()]);
  const screens = Array.isArray(screenList) ? screenList : [];
  if (DEBUG) console.log('[panel] icon', JSON.stringify(spot), 'mouse', JSON.stringify(mouse), 'screens', JSON.stringify(screens));
  // Under the icon. macOS reports an empty frame for an icon it isn't showing (one
  // hidden behind the notch, say), and then the click's position stands in for it.
  const placed = spot && spot.width > 0 && spot.height > 0;
  const anchorX = placed ? spot.x + spot.width / 2 : mouse?.x;
  const anchorY = placed ? spot.y : mouse?.y;
  const contains = (s) => anchorX >= s.x && anchorX < s.x + s.width && anchorY >= s.y && anchorY < s.y + s.height;
  const screen = screens.find(contains) || screens.find((s) => s.primary) || screens[0];
  const area = screen?.visible || screen;
  let x;
  let y;
  if (Number.isFinite(anchorX) && area) {
    x = Math.round(anchorX - PANEL_WIDTH / 2);
    x = Math.max(area.x + PANEL_GAP, Math.min(x, area.x + area.width - PANEL_WIDTH - PANEL_GAP));
    y = Math.round(placed ? spot.y + spot.height + PANEL_GAP : area.y + PANEL_GAP);
  }
  return { x, y };
}

async function openPanel() {
  if (panelOpen) return;
  const { x, y } = await panelPlace();
  const panel = app.window('main');
  if (Number.isFinite(x)) panel.setPosition(x, y);
  panel.push('servers', panelState());
  panel.push('panel-shown');
  panel.show(); // activate, so it has focus and closes when it loses it
  panelOpen = true;
}

// how: 'blur' when another app or window took the focus; 'dismiss' for Escape or a
// click on the icon, which hands the focus back to the app that had it
function closePanel(how = 'dismiss') {
  if (!panelOpen) return;
  panelOpen = false;
  panelFocused = false;
  if (how === 'blur') panelBlurredAt = Date.now();
  if (how === 'dismiss' && !settingsOpen) app.hide();
  else app.window('main').hide({ app: false }); // this window only
}

function togglePanel() {
  if (panelOpen) return closePanel('dismiss');
  if (panelOpening) return;
  // A click on the icon takes the focus from the panel on mouse-down, which closes
  // it, and arrives here on mouse-up: don't reopen what that click just closed
  if (Date.now() - panelBlurredAt < REOPEN_GUARD_MS) return;
  panelOpening = true;
  openPanel()
    .catch((e) => console.error('Could not open the panel:', e))
    .finally(() => {
      panelOpening = false;
    });
}

// Scans run one at a time. A call during a scan gets the next one, which starts when
// the current ends, so a caller always sees a list from after it asked.
let killGen = 0; // bumped by every kill: a scan that started before it is stale
let currentScan = null;
let nextScan = null;

function performRefresh() {
  if (!currentScan) {
    currentScan = runScan().finally(() => {
      currentScan = null;
    });
    return currentScan;
  }
  if (!nextScan) {
    nextScan = currentScan.then(() => {
      nextScan = null;
      return performRefresh();
    });
  }
  return nextScan;
}

async function runScan() {
  const gen = killGen;
  try {
    const found = await scanProcessListeners();
    // A kill ended while this scan ran: it may still list what was killed, and the
    // scan that kill asked for comes next
    if (gen !== killGen) return false;
    latestProcesses = found;
    scanned = true;
    updateTray();
    return true;
  } catch (e) {
    console.error('Refresh failed:', e);
    return false;
  }
}

function scheduleNextRefresh() {
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = null;

  const refreshPref = prefs.getRefreshMs();
  if (refreshPref === 'paused') return;

  refreshTimeout = setTimeout(() => {
    performRefresh().finally(() => scheduleNextRefresh());
  }, refreshPref);
}

// Never rejects: a failed scan logs itself
async function refreshNow() {
  await performRefresh();
  scheduleNextRefresh();
}

// The menu's Kill all opens the panel with its Kill all armed: one confirmation for
// both, on the servers listed when it was asked
async function armKillAll() {
  const pids = latestProcesses.map((p) => p.pid);
  if (pids.length === 0) return;
  await openPanel();
  app.window('main').push('arm-kill-all', { pids });
}

// A server that survives a kill from the menu: the panel shows why
async function killFromMenu(pid) {
  const result = await killListed([pid]);
  if (!result.ok && latestProcesses.some((p) => p.pid === pid)) {
    await openPanel();
    app.window('main').push('kill-error', { pid, error: result.error });
  }
}

function openPreferences() {
  app.win.open('prefs', { page: 'preferences.html', title: 'Settings', size: '420x564' });
  app.window('prefs').setResizable(false);
  // win.open orders the window front without activating the app: a menu bar agent
  // is rarely active, so the window would open behind the app in use
  app.window('prefs').show();
  settingsOpen = true;
}

// Updates: every GitHub release carries manifest.json and the app's zip, and tinyjs
// reads the latest one ("update" in tinyjs.json) a few seconds after launch and then
// daily. A newer version is offered in the panel and in Settings; installing it
// verifies the zip, swaps the app and relaunches it.
let availableUpdate = null; // { current, latest, notes }

function offerUpdate(info) {
  availableUpdate = info;
  app.window('main').push('update', info);
}

// -> 'enabled' | 'disabled' | 'requires-approval' | 'unsupported'
async function applyAutoLaunchSetting(enabled) {
  try {
    return await app.launchAtLogin.set(Boolean(enabled));
  } catch (e) {
    console.error('Failed to update auto-launch setting:', e);
    return null;
  }
}

async function buildPreferencesPayload() {
  // 'unsupported' under `tinyjs dev`: only a built .app can be a login item
  const loginStatus = await app.launchAtLogin.get();
  const values = prefs.getAllPreferences();
  // The login item itself is the truth: it can be removed in System Settings
  if (loginStatus !== 'unsupported') values.autoLaunch = loginStatus === 'enabled' || loginStatus === 'requires-approval';
  return { values, meta: { loginStatus } };
}

export const api = {
  getPreferences: () => buildPreferencesPayload(),

  async setAutoLaunch({ value }) {
    prefs.setAutoLaunch(value);
    await applyAutoLaunchSetting(value);
    return buildPreferencesPayload();
  },

  async setRefresh({ value }) {
    prefs.setRefreshMs(value);
    scheduleNextRefresh();
    return buildPreferencesPayload();
  },

  async setDisplayMode({ value }) {
    prefs.setDisplayMode(value);
    updateTray();
    return buildPreferencesPayload();
  },

  async setProcessType({ typeName, enabled }) {
    prefs.setProcessType(typeName, enabled);
    await refreshNow();
    return buildPreferencesPayload();
  },

  // The panel's calls
  getServers: () => panelState(),

  killServer: ({ pid }) => killListed([pid]),

  // pids: the servers listed when Kill all was armed, not whatever is listed by now
  killAll: ({ pids }) => killListed(pids),

  async refresh() {
    await refreshNow();
    return true;
  },

  openSettings() {
    closePanel('blur'); // Settings takes the focus
    openPreferences();
  },

  closePanel() {
    closePanel('dismiss');
  },

  getUpdate: () => availableUpdate,

  // Throws when offline or the release can't be read: the page says so
  async checkForUpdates() {
    const { available, current, latest, notes } = await app.update.check();
    if (available) offerUpdate({ current, latest, notes: notes ?? null });
    return { available, current, latest };
  },

  // Throws with the reason (not the packaged app, a bad download, …); on success the
  // app relaunches as the new version
  async installUpdate() {
    await app.update.install();
    return true;
  },

  quit() {
    app.quit();
  },
};

export async function init(tinyApp) {
  app = tinyApp;
  app.setHideOnClose(true); // if anything closes the panel window, it is put away, not quit
  app.window('main').setAllSpaces(true); // shows over a full-screen app instead of leaving it
  // Whatever goes wrong here, the icon and the scans must still start
  try {
    const imported = await prefs.load(app.store, tjs.homeDir);
    if (imported) {
      console.log('Imported the preferences of Node Killer');
      // Node Killer opened at login: so does Tiny Killer, once; from then on the login
      // item (and System Settings) decides
      if (prefs.getAutoLaunch() && (await app.launchAtLogin.get()) !== 'unsupported') await applyAutoLaunchSetting(true);
    }
    const { resources } = await app.paths();
    if (resources) trayIcon = `${resources}/tray.png`;
  } catch (e) {
    console.error('Startup:', e);
  }
  updateTray();
  await refreshNow();
}

export function onTray(id) {
  if (id == null) {
    togglePanel(); // a left click on the icon
    return;
  }
  if (typeof id === 'string' && id.startsWith('kill:')) {
    killFromMenu(Number(id.slice('kill:'.length))).catch((e) => console.error('Kill failed:', e));
    return;
  }
  switch (id) {
    case 'kill-all':
      armKillAll().catch((e) => console.error('Kill all failed:', e));
      break;
    case 'refresh':
      refreshNow();
      break;
    case 'preferences':
      openPreferences();
      break;
    case 'quit':
      app.quit();
      break;
  }
}

export function onUpdateAvailable(info) {
  offerUpdate(info);
}

export function onWindowClosed(id) {
  if (id === 'prefs') settingsOpen = false;
}

export function onWindowState({ win, focused }) {
  if (win !== 'main' || !panelOpen) return;
  if (focused) panelFocused = true;
  else if (panelFocused) closePanel('blur'); // a click anywhere else
}

// Our pages never navigate: a link dropped on a window opens in the browser instead
export function onNavigate(info) {
  if (info.kind === 'policy' && /^https?:/i.test(info.url || '')) return 'external';
}
