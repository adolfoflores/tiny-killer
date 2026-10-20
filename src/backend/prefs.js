// User preferences on tiny.store. tiny.store is async, so the values load once at
// startup, are read from memory and written through.

export const DEFAULT_REFRESH_MS = 5000;
export const REFRESH_CHOICES = [1000, 5000, 10000, 'paused'];
export const DISPLAY_MODES = ['number', 'icon-plus-number', 'number-plus-memory', 'number-plus-cpu', 'icon-only'];

const defaults = {
  autoLaunch: false,
  refreshMs: DEFAULT_REFRESH_MS,
  displayMode: 'number',
  processTypes: { node: true, vite: true, bun: true },
};

// Where Node Killer (the Electron app) keeps its preferences, relative to the home folder
const NODE_KILLER_PREFS = 'Library/Application Support/Node-Killer/preferences.json';

let store = null;
let values = {};

function get(key) {
  return key in values ? values[key] : defaults[key];
}

function set(key, value) {
  values[key] = value;
  store.set(key, value); // never rejects; a failed write stays in memory until the next one
  return value;
}

// Only the choices the settings window offers: anything else would scan non-stop
// or leave the window showing no choice
function sanitizeRefresh(value) {
  if (value === 'paused') return 'paused';
  const num = Number(value);
  return REFRESH_CHOICES.includes(num) ? num : undefined;
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// On the first run, start from Node Killer's preferences if it is installed
async function importFromNodeKiller(home) {
  let saved;
  try {
    saved = JSON.parse(new TextDecoder().decode(await tjs.readFile(`${home}/${NODE_KILLER_PREFS}`)));
  } catch {
    return false;
  }
  if (!isPlainObject(saved)) return false;
  if ('autoLaunch' in saved) setAutoLaunch(saved.autoLaunch);
  if ('refreshMs' in saved) setRefreshMs(saved.refreshMs);
  if ('displayMode' in saved) setDisplayMode(saved.displayMode);
  if (isPlainObject(saved.processTypes)) setProcessTypes({ ...defaults.processTypes, ...saved.processTypes });
  return true;
}

// -> true when this run imported Node Killer's preferences
export async function load(appStore, home) {
  store = appStore;
  const saved = await store.all();
  values = isPlainObject(saved) ? saved : {};
  if (Object.keys(defaults).some((key) => key in values)) return false;
  return importFromNodeKiller(home);
}

export function getAutoLaunch() {
  return Boolean(get('autoLaunch'));
}

export function setAutoLaunch(value) {
  return set('autoLaunch', Boolean(value));
}

export function getRefreshMs() {
  return sanitizeRefresh(get('refreshMs')) ?? set('refreshMs', DEFAULT_REFRESH_MS);
}

export function setRefreshMs(value) {
  return set('refreshMs', sanitizeRefresh(value) ?? DEFAULT_REFRESH_MS);
}

export function getDisplayMode() {
  const value = get('displayMode');
  return DISPLAY_MODES.includes(value) ? value : set('displayMode', 'number');
}

export function setDisplayMode(value) {
  return set('displayMode', DISPLAY_MODES.includes(value) ? value : 'number');
}

export function getProcessTypes() {
  const stored = get('processTypes');
  return { node: stored?.node !== false, vite: stored?.vite !== false, bun: stored?.bun !== false };
}

export function setProcessTypes(types) {
  return set('processTypes', { node: Boolean(types?.node), vite: Boolean(types?.vite), bun: Boolean(types?.bun) });
}

export function setProcessType(typeName, enabled) {
  return setProcessTypes({ ...getProcessTypes(), [typeName]: Boolean(enabled) });
}

export function getAllPreferences() {
  return {
    autoLaunch: getAutoLaunch(),
    refreshMs: getRefreshMs(),
    displayMode: getDisplayMode(),
    processTypes: getProcessTypes(),
  };
}
