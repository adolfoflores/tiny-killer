// The settings window: every change goes to the backend (src/backend/main.js),
// which saves it, applies it and answers with the full state to show.

const autoLaunch = document.querySelector('#autoLaunch');
const autoLaunchNote = document.querySelector('#autoLaunchNote');
const displayMode = document.querySelector('#displayMode');
const refreshMs = document.querySelector('#refreshMs');
const processTypes = Array.from(document.querySelectorAll('[data-type]'));
const repoLink = document.querySelector('#repoLink');
const updateNote = document.querySelector('#updateNote');
const updateButton = document.querySelector('#updateButton');

// What the launch at login status means for the switch
const LOGIN_NOTES = {
  unsupported: 'Only works in the installed app.',
  'requires-approval': 'Allow it in System Settings › Login Items.',
};

function show({ values, meta }) {
  autoLaunch.checked = values.autoLaunch;
  autoLaunch.disabled = meta.loginStatus === 'unsupported';
  const note = values.autoLaunch || meta.loginStatus === 'unsupported' ? LOGIN_NOTES[meta.loginStatus] : null;
  autoLaunchNote.textContent = note || '';
  autoLaunchNote.hidden = !note;

  displayMode.value = values.displayMode;
  refreshMs.value = String(values.refreshMs);
  for (const input of processTypes) {
    input.checked = values.processTypes[input.dataset.type] !== false;
  }
  fitWindow();
}

// The window takes the height of its content, which grows when a note shows up
function fitWindow() {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height !== window.innerHeight) tiny.win.setSize(window.innerWidth, height);
}

// Call the backend and show the state it answers with; on failure, reload the real state
async function update(method, params) {
  try {
    show(await tiny.api.call(method, params));
  } catch (error) {
    tiny.log(`${method} failed: ${error?.message || error}`);
    show(await tiny.api.call('getPreferences'));
  }
}

autoLaunch.addEventListener('change', () => update('setAutoLaunch', { value: autoLaunch.checked }));
displayMode.addEventListener('change', () => update('setDisplayMode', { value: displayMode.value }));
refreshMs.addEventListener('change', () => {
  update('setRefresh', { value: refreshMs.value === 'paused' ? 'paused' : Number(refreshMs.value) });
});
for (const input of processTypes) {
  input.addEventListener('change', () => update('setProcessType', { typeName: input.dataset.type, enabled: input.checked }));
}

// Updates: the backend checks daily on its own; Check Now asks at once, and once a
// newer version is known the same button installs it (the app then relaunches)
let updateFound = null;

function showUpdateState(note, button) {
  updateNote.textContent = note;
  updateButton.textContent = button;
  fitWindow();
}

function offer(info) {
  updateFound = info;
  if (info) showUpdateState(`Version ${info.latest} is available.`, 'Update');
}

updateButton.addEventListener('click', async () => {
  updateButton.disabled = true;
  try {
    if (updateFound) {
      showUpdateState('Updating…', 'Update');
      await tiny.api.call('installUpdate');
      return;
    }
    showUpdateState('Checking…', 'Check Now');
    const result = await tiny.api.call('checkForUpdates');
    if (result.available) offer(result);
    else showUpdateState("You're up to date.", 'Check Now');
  } catch (error) {
    // Offline is ordinary: a failed check just says so; a failed install says why
    if (updateFound) showUpdateState(`Couldn't update: ${error?.message || error}`, 'Update');
    else showUpdateState("Couldn't check for updates right now.", 'Check Now');
    tiny.log(`update: ${error?.message || error}`);
  } finally {
    updateButton.disabled = false;
  }
});

// ⌘W closes the window, as anywhere on macOS (this app has no File menu to carry it)
document.addEventListener('keydown', (event) => {
  if (event.metaKey && event.key === 'w') {
    event.preventDefault();
    tiny.win.close();
  }
});

// Links open in the browser, not in this window
repoLink.addEventListener('click', (event) => {
  event.preventDefault();
  tiny.app.shell.open(repoLink.href);
});

tiny.app.info().then(({ version }) => {
  document.querySelector('#version').textContent = `Version ${version}`;
});
update('getPreferences');
tiny.api.call('getUpdate').then(offer);
