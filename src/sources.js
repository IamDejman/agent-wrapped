import os from 'node:os';
import path from 'node:path';
import { amp } from './parsers/amp.js';
import { antigravity } from './parsers/antigravity.js';
import { claude } from './parsers/claude.js';
import { codex } from './parsers/codex.js';
import { copilot } from './parsers/copilot.js';
import { cursor } from './parsers/cursor.js';
import { gemini } from './parsers/gemini.js';
import { grok } from './parsers/grok.js';
import { opencode } from './parsers/opencode.js';
import { TOOL_NAMES } from './tools.js';
import { appUserDirs, ls } from './util.js';

/**
 * Every tool the wrap can read. A reader either lists files and reads one at a
 * time (list + read) or reads one database whole (stamp + read). "api" has no
 * reader: it only holds usage exports the user imported.
 */
export const SOURCES = [claude, codex, cursor, antigravity, grok, gemini, opencode, copilot, amp, { id: 'api' }].map((s) =>
  Object.assign(s, { name: TOOL_NAMES[s.id] }),
);

const home = os.homedir();
const vscode = (extension) => ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'].flatMap((app) => appUserDirs(app).map((d) => path.join(d, 'globalStorage', extension, 'tasks')));

/** Tools whose history has a known home but no reader yet. They are reported, never silently skipped. */
const UNREAD = [
  ['Kimi Code', [path.join(home, '.kimi-code', 'sessions'), path.join(home, '.kimi', 'sessions')]],
  ['Windsurf', [path.join(home, '.codeium', 'windsurf', 'cascade')]],
  ['Cline', vscode('saoudrizwan.claude-dev')],
  ['Roo Code', vscode('rooveterinaryinc.roo-cline')],
  ['Continue', [path.join(home, '.continue', 'sessions')]],
  ['Goose', [path.join(home, '.local', 'share', 'goose', 'sessions')]],
  ['Qwen Code', [path.join(home, '.qwen', 'tmp')]],
  ['Factory Droid', [path.join(home, '.factory', 'sessions')]],
  ['Zed', [path.join(home, 'Library', 'Application Support', 'Zed', 'threads'), path.join(home, '.local', 'share', 'zed', 'threads')]],
];

/** [name, folder] for each unread tool that has history on this machine. */
export function unreadTools() {
  return UNREAD.flatMap(([name, dirs]) => {
    const dir = dirs.find((d) => ls(d).length > 0);
    return dir ? [[name, dir]] : [];
  });
}
