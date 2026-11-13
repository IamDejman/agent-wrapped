// Import this first in every test file: readers work out where history lives
// when they are loaded, so the made-up home folder has to exist before they are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wrapped-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'AGENT_WRAPPED_API']) delete process.env[name];
process.env.AGENT_WRAPPED_HOME = path.join(home, '.agent-wrapped');
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

/** A project folder that never exists: readers only use its name. */
export const PROJECT = '/Users/dev/code/alpha';

export const at = (...parts) => path.join(home, ...parts);

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export const json = (file, value) => write(file, JSON.stringify(value));
export const jsonl = (file, records) => write(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

/** Every event a reader produces, read straight from disk. */
export async function collect(source) {
  const events = [];
  const emit = (ev) => events.push(ev);
  if (source.list) for (const entry of source.list()) await source.read(entry, emit);
  else if (source.stamp()) await source.read(emit);
  return events;
}

export const kinds = (events, kind) => events.filter((ev) => ev.kind === kind);
