// What the app shows for the servers found, in the order sortProcesses gives them:
// the tray menu (right click) and the data for the panel (left click). Both group
// the servers by project under a summary. Pure, so `npm test` covers it.
import {
  buildProcessLabel,
  formatCpu,
  formatMemory,
  formatProject,
  formatUptime,
  memoryKbOf,
  summarizeCommand,
  summarizeServers,
} from './scanner.js';

const INDENT = '\u2003'; // an em space sets each server under its project
const NO_PROJECT = 'Other';

// searching: nothing has been scanned yet, so an empty list means nothing yet
export function buildMenu(procs = [], { searching = false } = {}) {
  const items = [];
  if (procs.length === 0) {
    const label = searching ? 'Looking for dev servers…' : 'All quiet — no dev servers running';
    items.push({ id: 'empty', label, enabled: false });
  } else {
    items.push({ id: 'summary', label: summarizeServers(procs), enabled: false }, { separator: true });
    let group = null;
    for (const proc of procs) {
      const project = formatProject(proc.project) || NO_PROJECT;
      if (project !== group) {
        group = project;
        items.push({ id: `project:${project}`, label: project, enabled: false });
      }
      items.push({ id: `kill:${proc.pid}`, label: `${INDENT}${buildProcessLabel(proc)}` });
    }
  }
  items.push(
    { separator: true },
    { id: 'kill-all', label: `Kill all (${procs.length})`, enabled: procs.length > 0 },
    { id: 'refresh', label: 'Refresh', key: 'r' },
    { id: 'preferences', label: 'Settings…', key: ',' },
    { id: 'quit', label: 'Quit Tiny Killer', key: 'q' },
  );
  return items;
}

// The panel's data: plain values, formatted here so the page only lays them out
export function buildPanel(procs = [], { searching = false } = {}) {
  const groups = [];
  for (const proc of procs) {
    const key = formatProject(proc.project);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, project: proc.project?.project || NO_PROJECT, worktree: proc.project?.worktree || null, servers: [] };
      groups.push(group);
    }
    const ports = Array.isArray(proc.ports) ? proc.ports : [];
    // What the row has no room for: kind, PID and CPU, the folder, the whole command
    const facts = [proc.type || 'node', `PID ${proc.pid}`];
    if (proc.stats) facts.push(`CPU ${formatCpu(proc.stats.cpu)}`);
    group.servers.push({
      pid: proc.pid,
      ports: ports.length > 0 ? ports.map((port) => `:${port}`).join(' ') : `pid ${proc.pid}`,
      command: proc.commandLine ? summarizeCommand(proc.commandLine, 48) : '',
      memory: proc.stats ? formatMemory(memoryKbOf(proc.stats)) : '',
      uptime: proc.stats ? formatUptime(proc.stats.elapsedSeconds) : '',
      details: [facts.join(' · '), proc.cwd, proc.commandLine].filter(Boolean).join('\n'),
    });
  }
  return { searching, count: procs.length, summary: procs.length > 0 ? summarizeServers(procs) : null, groups };
}
