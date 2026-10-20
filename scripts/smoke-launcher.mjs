#!/usr/bin/env node
// Stand-in for tinyjs' native launcher, to drive the backend without clicking the menu
// bar. It speaks the launcher's socket protocol, prints the lines that go by (tray
// specs, windows, calls) and plays a scripted session:
//   1. waits for a tray menu listing TK_TARGET_PID and clicks its item (kills it)
//   2. checks the panel (the main window, built hidden at launch) has its page loaded,
//      then left-clicks the icon: it shows, lists the servers, kills TK_PANEL_PID with
//      its button and refuses a PID it doesn't list
//   3. clicks "Settings…" and checks the page asks for the settings (with the real
//      launcher, Settings taking the focus also puts the panel away), then opens the
//      panel again
//   4. clicks "Kill all" in the menu: the panel opens with Kill all armed; closing it
//      cancels
//   5. clicks "Quit"
//
//   TK_TARGET_PID=<pid of a throwaway server> TK_PANEL_PID=<another one> \
//   TINYJS_LAUNCHER=$PWD/scripts/smoke-launcher.mjs tinyjs dev
//
// Alone it plays the pages too. With TK_SMOKE_RELAY=1 it starts the real launcher
// behind itself and passes everything through, so the real menu and windows run and
// only the clicks are injected. TK_HOLD_MS keeps the app up that long before Quit,
// to measure it.
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';

const [, , pagePath, sockPath, ...launcherArgs] = process.argv;
const targetPid = Number(process.env.TK_TARGET_PID);
const panelPid = Number(process.env.TK_PANEL_PID);
const relay = process.env.TK_SMOKE_RELAY === '1';
const started = performance.now();
const log = (...args) => console.log(`[smoke +${Math.round(performance.now() - started)}ms]`, ...args);
const short = (line) => (line.length > 300 ? line.slice(0, 300) + '…' : line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Line-framed socket with a handler per line
function lines(socket, onLine) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
}

const waiters = [];
function waitFor(predicate, what, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    waiters.push({ predicate, resolve: (v) => (clearTimeout(timer), resolve(v)) });
  });
}
function emit(event) {
  for (const w of [...waiters]) {
    if (w.predicate(event)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(event);
    }
  }
}

const backend = net.createConnection(sockPath);
let launcher = null; // the real launcher's socket, in relay mode
let launcherProc = null;
const queued = []; // backend lines sent before the real launcher connected

function toBackend(line) {
  log('>>', short(line));
  backend.write(line + '\n');
}

// Lines the backend sends: tray specs are parsed in both modes; without a real
// launcher, queries get the answers a dev-mode launcher gives
let tray = null;
let building = null;
const ANSWERS = { LOGIN: { status: 'unsupported' } };
const injected = new Set(); // calls this script made with a real launcher: their answers stop here
const seen = new Set(); // things that may happen before a step waits for them
const happened = (key, event) => seen.has(key) || waitFor(event, key, 10000);
function fromBackend(line) {
  const [op, ...rest] = line.split(' ');
  if (op === 'TRAYBEGIN') {
    const [title, icon, , tooltip] = rest.join(' ').split('\t');
    building = { title, icon, tooltip, items: [] };
  } else if (op === 'ITEM' && building) {
    building.items.push(rest.join(' ').split('\t'));
  } else if (op === 'SEP' && building) {
    building.items.push(['—']);
  } else if (op === 'TRAYEND' && building) {
    tray = building;
    building = null;
    log('tray', JSON.stringify({ title: tray.title, icon: tray.icon, tooltip: tray.tooltip }));
    for (const item of tray.items) log('   ', item.join(' | '));
    emit({ type: 'tray', tray });
  } else if (!['ITEM', 'SEP', 'EVAL', 'EVAL@*'].includes(op)) { // pushes come with every scan
    log('<<', short(line));
  }

  if (op === 'RET') {
    const [id, status, ...json] = rest;
    emit({ type: 'RET', id, ok: status === '0', value: json.length ? JSON.parse(json.join(' ')) : null });
    if (injected.delete(id)) return;
  } else {
    emit({ type: op, line });
  }

  if (relay) {
    if (launcher) launcher.write(line + '\n');
    else queued.push(line);
  } else if (op in ANSWERS || op === 'GET') {
    toBackend(`GOT ${rest[0]} ${JSON.stringify(ANSWERS[op] ?? null)}`);
  } else if (op === 'QUIT') {
    process.exit(0);
  }
}

// Lines the real launcher sends, on their way to the backend
function fromLauncher(line) {
  log('<L', short(line));
  backend.write(line + '\n');
  if (line.startsWith('CALL ')) {
    const [, id, args] = line.match(/^CALL (\S+) (.*)$/) || [];
    try {
      const method = JSON.parse(JSON.parse(args)[0]).method;
      if (method === 'getServers') seen.add('the panel page loaded');
      emit({ type: 'CALL', id, method });
    } catch {}
  }
}

// Plays the page side of a call (with a real launcher too, for buttons it can't click)
let callSeq = 0;
async function call(method, params, win) {
  const id = `${win}:${900 + ++callSeq}`;
  if (relay) injected.add(id);
  const done = waitFor((e) => e.type === 'RET' && e.id === id, `the answer to ${method}`, 5000);
  toBackend(`CALL ${id} ${JSON.stringify([JSON.stringify({ method, params }), 'file://'])}`);
  const ret = await done;
  if (!ret.ok) throw new Error(`${method} failed: ${JSON.stringify(ret.value)}`);
  return ret.value;
}

const hasItem = (id) => (e) => e.type === 'tray' && e.tray.items.some((item) => item[0] === id);
const listedPids = () => (tray?.items || []).filter((item) => item[0].startsWith('kill:')).map((item) => Number(item[0].slice(5)));

async function main() {
  // 1. Kill the throwaway server from its menu item
  if (Number.isFinite(targetPid) && targetPid > 0) {
    // The menu may already have it: it is only sent again when something changes
    if (!hasItem(`kill:${targetPid}`)({ type: 'tray', tray: tray || { items: [] } })) {
      await waitFor(hasItem(`kill:${targetPid}`), `a menu item for PID ${targetPid}`);
    }
    toBackend(`TRAY kill:${targetPid}`);
    await waitFor((e) => e.type === 'tray' && !hasItem(`kill:${targetPid}`)(e), `PID ${targetPid} to leave the menu`);
    log(`OK: PID ${targetPid} is gone from the menu`);
  }

  // 2. The panel: the main window, built hidden at launch, so a click only shows it
  if (relay) {
    await happened('the panel page loaded', (e) => e.type === 'CALL' && e.method === 'getServers');
    log('OK: the panel page was loaded before any click');
  }
  const firstShown = waitFor((e) => e.line === 'WINOP show', 'the panel to show', 3000);
  const firstClick = performance.now();
  toBackend('TRAYCLICK');
  await firstShown;
  log(`OK: the first click showed the panel in ${Math.round(performance.now() - firstClick)} ms`);
  const servers = await call('getServers', null, 'main');
  log(`OK: the panel opened and lists ${servers.summary || 'nothing'}`);
  if (Number.isFinite(panelPid) && panelPid > 0) {
    const result = await call('killServer', { pid: panelPid }, 'main');
    log(result.ok ? `OK: the panel's kill button stopped PID ${panelPid}` : `FAIL: the panel couldn't stop PID ${panelPid}: ${result.error}`);
  }
  const refused = await call('killServer', { pid: 1 }, 'main');
  log(refused.ok ? 'FAIL: the panel killed a PID it does not list' : 'OK: the panel refuses PIDs it does not list');
  const staleAll = await call('killAll', { pids: [1] }, 'main');
  log(staleAll.ok ? 'FAIL: Kill all stopped a PID it does not list' : 'OK: Kill all only stops listed servers');
  if (!relay) await call('closePanel', null, 'main'); // as Escape does

  // 3. Settings: the window opens and its page asks for the values
  if (relay) {
    const blurred = waitFor((e) => e.line === 'WINOP hidewin', 'the panel to hide', 5000);
    const opened = waitFor((e) => e.type === 'CALL' && e.method === 'getPreferences', 'the preferences page', 10000);
    toBackend('TRAY preferences');
    await opened;
    log('OK: the preferences page loaded and called getPreferences');
    log(await blurred.then(() => 'OK: the panel went away when Settings took the focus', (e) => `FAIL: ${e.message}`));
    await sleep(1500);
    launcher.write('WINCLOSE prefs\n');
  } else {
    toBackend('TRAY preferences');
    const prefs = await call('getPreferences', null, 'prefs');
    log('preferences:', JSON.stringify(prefs));
    const changed = await call('setDisplayMode', { value: 'number-plus-memory' }, 'prefs');
    log('display mode now:', changed.values.displayMode);
    await call('setDisplayMode', { value: prefs.values.displayMode }, 'prefs');
  }

  // The panel again
  const shown = waitFor((e) => e.line === 'WINOP show', 'the panel to show again', 3000);
  await sleep(400); // a click right after it went away counts as the one that put it away
  const clickedAt = performance.now();
  toBackend('TRAYCLICK');
  await shown;
  log(`OK: the panel showed again in ${Math.round(performance.now() - clickedAt)} ms`);
  await call('closePanel', null, 'main');

  // 4. Kill all in the menu opens the panel with Kill all armed; closing it cancels
  if (listedPids().length === 0) {
    log('skipped Kill all: nothing listed');
  } else {
    const armed = waitFor((e) => e.type === 'EVAL' && e.line.includes('arm-kill-all'), 'the panel armed', 3000);
    const shownArmed = waitFor((e) => e.line === 'WINOP show', 'the panel to show', 3000);
    toBackend('TRAY kill-all');
    await Promise.all([armed, shownArmed]);
    log('OK: Kill all in the menu opened the panel armed');
    await call('closePanel', null, 'main');
  }

  // 5. Quit from the menu (TK_HOLD_MS keeps the app up first, to measure it)
  if (process.env.TK_HOLD_MS) await sleep(Number(process.env.TK_HOLD_MS));
  toBackend('TRAY quit');
  if (relay) {
    await sleep(3000);
    launcherProc?.kill(); // in case the launcher is slow to go
  }
}

function run() {
  main().catch((err) => {
    log('FAIL:', err.message);
    launcherProc?.kill();
    process.exit(1);
  });
}

lines(backend, fromBackend);
backend.on('close', () => {
  launcherProc?.kill();
  process.exit(0);
});

backend.on('connect', () => {
  log('connected to', sockPath);
  if (!relay) return run();

  // The real launcher connects to a socket of ours instead of the backend's
  const relaySock = `${sockPath}.relay`;
  const server = net.createServer((socket) => {
    launcher = socket;
    for (const line of queued.splice(0)) socket.write(line + '\n');
    lines(socket, fromLauncher);
    log('real launcher connected');
    run();
  });
  server.listen(relaySock, () => {
    const real = process.env.TK_REAL_LAUNCHER || `${os.homedir()}/.tinyjs/native/launcher-macos`;
    launcherProc = spawn(real, [pagePath, relaySock, ...launcherArgs], { stdio: 'inherit' });
    launcherProc.on('exit', () => process.exit(0)); // closing our end lets the backend exit too
  });
});
