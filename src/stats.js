import { price } from './pricing.js';
import { TOOL_NAMES } from './tools.js';

const GAP = 5 * 60_000; // pauses longer than this don't count as time spent
const DAY_MS = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNumber = (key) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY_MS);
const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);

const cap = (word) => `${word[0].toUpperCase()}${word.slice(1)}`;

/**
 * claude-opus-5-5 -> Opus 5.5, claude-3-5-sonnet-20241022 -> Sonnet 3.5,
 * gemini-3.8-flash-n -> Gemini 3.8 Flash, gemini-default -> Gemini,
 * gpt-6.1-sol -> GPT 6.1 Sol, grok-4.7-xhigh-fast -> Grok 4.7, grok-build -> Grok Build;
 * other ids pass through.
 */
export function prettyModel(id) {
  if (!id) return 'Unknown';
  if (id.startsWith('gemini-')) {
    const [first, second] = id.slice(7).split('-');
    if (!/^\d/.test(first)) return 'Gemini';
    return `Gemini ${first}${/^[a-z]{2,}$/.test(second ?? '') ? ` ${cap(second)}` : ''}`;
  }
  const other = /^(gpt|grok)-(\d[\d.]*)(?:-([a-z]+))?/.exec(id);
  if (other) return other[1] === 'grok' ? `Grok ${other[2]}` : `GPT ${other[2]}${other[3] ? ` ${cap(other[3])}` : ''}`;
  if (/^grok-[a-z]+$/.test(id)) return `Grok ${cap(id.slice(5))}`;
  if (!id.startsWith('claude-')) return id;
  const parts = id.slice(7).replace(/-\d{8}$/, '').split('-');
  const name = parts.find((p) => /^[a-z]+$/.test(p));
  const version = parts.filter((p) => /^\d+(\.\d+)?$/.test(p)).join('.');
  return name ? `${cap(name)} ${version}`.trim() : id;
}

// Each app names its tools differently. These are the calls that mean the same
// thing to a person; plumbing such as task lists and tool lookups is left out.
const ACTIONS = [
  ['Ran commands', /^(bash|run_command|run_terminal_cmd|run_terminal_command|exec|exec_command|shell|local_shell)$/],
  ['Read files', /^(read|read_file|view_file|notebookread)$/],
  ['Edited files', /^(edit|multiedit|write|notebookedit|edit_file|write_to_file|replace_file_content|multi_replace_file_content|apply_patch|search_replace|strreplace|write_file|append_to_file)$/],
  ['Searched code', /^(grep|glob|grep_search|ripgrep_raw_search|glob_file_search|codebase_search|file_search|find_by_name|list_dir|search_contents|list_files_by_prefix)$/],
  ['Searched the web', /^(webfetch|websearch|web_search|search_web|web_fetch|read_url_content)$/],
  ['Ran subagents', /^(agent|task|spawn_agent|spawn_subagent)$/],
];

function action(tool) {
  const name = tool.toLowerCase();
  if (/browser|chrome/.test(name)) return 'Used a browser';
  const short = name.replace(/^mcp__.*__/, '').replace(/_v\d+$/, '');
  return ACTIONS.find(([, re]) => re.test(short))?.[0];
}

/**
 * One persona per wrap, first match wins. The name alone means nothing to
 * someone seeing a shared card, so each comes with what it means in plain
 * words and the numbers that earned it. Neither says "you" or names a
 * project: both are printed on the image that gets shared.
 */
function persona({ prompts, hours, weekdays, projects, projectCount, tools }) {
  const share = (n) => (prompts ? n / prompts : 0);
  const night = share(hours.slice(22).concat(hours.slice(0, 5)).reduce((a, b) => a + b, 0));
  const dawn = share(hours.slice(5, 9).reduce((a, b) => a + b, 0));
  const weekend = share(weekdays[0] + weekdays[6]);
  const topProject = projects[0] ? share(projects[0].prompts) : 0;
  const second = tools[1] ? share(tools[1].prompts) : 0;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const is = (title, means, line) => ({ title, means, line });

  if (night >= 0.3) return is('The Night Shift', 'Works with AI late at night', `${pct(night)} of prompts sent between 10pm and 5am`);
  if (dawn >= 0.3) return is('The Dawn Patrol', 'Starts with AI early in the morning', `${pct(dawn)} of prompts sent between 5am and 9am`);
  if (second >= 0.2) return is('The Polyglot', 'Splits the work between AI tools', `${tools[0].name} ${pct(share(tools[0].prompts))} of prompts, ${tools[1].name} ${pct(second)}`);
  if (weekend >= 0.35) return is('The Weekend Builder', 'Builds on weekends', `${pct(weekend)} of prompts sent on a Saturday or Sunday`);
  if (projectCount >= 5 && topProject <= 0.3) return is('The Juggler', 'Keeps many projects going at once', `${projectCount} projects, none with more than ${pct(topProject)} of prompts`);
  if (topProject >= 0.6) return is('The Deep Diver', 'Puts almost everything into one project', `${pct(topProject)} of prompts went into one project`);
  return is('The Steady Hand', 'Works at an even pace', 'No late nights, no weekend rush, no single project taking over');
}

/** Consumes normalised events one at a time and produces the wrap's numbers. */
export class Wrap {
  constructor(year, { paidPerMonth = 0 } = {}) {
    this.year = year;
    this.paidPerMonth = paidPerMonth;
    this.seen = new Set(); // ids already counted: forked chats and overlapping exports repeat events
    this.months = new Map(); // yyyy-mm -> { prompts, tokens, usd }
    this.dayCost = new Map();
    this.saved = 0; // USD prompt caching took off the list-price bill
    this.start = new Date(year, 0, 1).getTime();
    this.end = new Date(year + 1, 0, 1).getTime();
    this.first = Infinity;
    this.last = 0;
    this.tools = {};
    this.days = new Map();
    this.hours = new Array(24).fill(0);
    this.weekdays = new Array(7).fill(0);
    this.projects = new Map();
    this.models = new Map();
    this.toolCalls = 0;
    this.actions = new Map();
    this.cost = new Map(); // model -> USD at list prices
    this.unpriced = 0; // tokens on models with no published price
    this.sessions = new Map();
    this.spans = []; // flat [start, end, ...] of stretches with no pause over GAP
    this.tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    this.thinkMs = 0;
    this.linesAdded = 0;
    this.otherYears = new Set(); // years with data outside the one being wrapped
  }

  add(ev) {
    if (!(ev.ts >= this.start && ev.ts < this.end)) {
      this.otherYears.add(new Date(ev.ts).getFullYear());
      return;
    }
    if (ev.id) {
      const key = `${ev.tool}|${ev.kind}|${ev.id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    if (ev.kind === 'lines') {
      this.linesAdded += ev.n;
      return;
    }
    const t = (this.tools[ev.tool] ??= { prompts: 0, replies: 0, tokens: 0, days: new Set() });
    if (ev.ts < this.first) this.first = ev.ts;
    if (ev.ts > this.last) this.last = ev.ts;

    if (ev.kind === 'tool') {
      this.toolCalls++;
      const name = action(ev.name);
      if (name) bump(this.actions, name);
      return;
    }

    if (ev.main && ev.session) {
      const key = `${ev.tool}:${ev.session}`;
      const s = this.sessions.get(key);
      if (!s) {
        this.sessions.set(key, { tool: ev.tool, last: ev.ts });
      } else {
        const gap = ev.ts - s.last;
        if (gap > 0) {
          if (gap < GAP) this.spans.push(s.last, ev.ts);
          s.last = ev.ts;
        }
      }
    }

    if (ev.kind === 'activity') return; // counts towards time spent, nothing else

    const d = new Date(ev.ts);
    const month = monthKey(d);
    if (!this.months.has(month)) this.months.set(month, { prompts: 0, tokens: 0, usd: 0 });
    const m = this.months.get(month);

    if (ev.kind === 'reply') {
      const total = ev.in + ev.out + ev.cacheRead + ev.cacheWrite;
      this.tokens.in += ev.in;
      this.tokens.out += ev.out;
      this.tokens.cacheRead += ev.cacheRead;
      this.tokens.cacheWrite += ev.cacheWrite;
      t.tokens += total;
      t.replies++;
      this.thinkMs += ev.thinkMs || 0;
      if (ev.model) bump(this.models, prettyModel(ev.model));
      m.tokens += total;
      const cost = price(ev);
      if (!cost) this.unpriced += total;
      else {
        bump(this.cost, prettyModel(ev.model), cost.usd);
        bump(this.dayCost, dayKey(d), cost.usd);
        m.usd += cost.usd;
        this.saved += cost.saved;
      }
      return;
    }

    // prompt
    const day = dayKey(d);
    m.prompts++;
    t.prompts++;
    t.days.add(day);
    bump(this.days, day);
    this.hours[d.getHours()]++;
    this.weekdays[d.getDay()]++;
    if (ev.project) bump(this.projects, ev.project);
  }

  get empty() {
    return this.last === 0;
  }

  finish() {
    const sessions = [...this.sessions.values()];
    const tools = Object.entries(this.tools)
      .map(([id, t]) => {
        return {
          id,
          name: TOOL_NAMES[id] ?? id,
          prompts: t.prompts,
          replies: t.replies,
          tokens: t.tokens,
          days: t.days.size,
          sessions: sessions.filter((s) => s.tool === id).length,
        };
      })
      .sort((a, b) => b.prompts - a.prompts || b.tokens - a.tokens);

    const dayKeys = [...this.days.keys()].sort();
    let streak = { days: 0, from: null, to: null };
    let run = { days: 0, from: null };
    let prev = null;
    for (const key of dayKeys) {
      const n = dayNumber(key);
      run = prev !== null && n === prev + 1 ? { days: run.days + 1, from: run.from } : { days: 1, from: key };
      if (run.days > streak.days) streak = { days: run.days, from: run.from, to: key };
      prev = n;
    }

    const busiest = top(this.days, 1)[0];
    // Sessions overlap, so merge their stretches into wall-clock time.
    const spans = [];
    for (let i = 0; i < this.spans.length; i += 2) spans.push([this.spans[i], this.spans[i + 1]]);
    spans.sort((a, b) => a[0] - b[0]);
    let activeMs = 0;
    let longestRun = null;
    let open = null;
    const close = () => {
      if (!open) return;
      const ms = open[1] - open[0];
      activeMs += ms;
      if (ms > (longestRun?.ms ?? 0)) longestRun = { ms, date: dayKey(new Date(open[0])) };
    };
    for (const [a, b] of spans) {
      if (open && a <= open[1]) open[1] = Math.max(open[1], b);
      else {
        close();
        open = [a, b];
      }
    }
    close();
    const prompts = tools.reduce((n, t) => n + t.prompts, 0);
    const projects = top(this.projects, 5).map(([name, n]) => ({ name, prompts: n }));
    // Every month from the first to the last, so a quiet month shows as a gap rather than vanishing.
    const months = [];
    for (let i = new Date(this.first).getMonth(); i <= new Date(this.last).getMonth(); i++) {
      const month = `${this.year}-${pad(i + 1)}`;
      months.push({ month, ...(this.months.get(month) ?? { prompts: 0, tokens: 0, usd: 0 }) });
    }
    const priciest = top(this.dayCost, 1)[0];
    const tokens = { ...this.tokens, total: Object.values(this.tokens).reduce((a, b) => a + b, 0) };

    return {
      year: this.year,
      from: dayKey(new Date(this.first)),
      to: dayKey(new Date(this.last)),
      tools,
      totals: {
        prompts,
        replies: tools.reduce((n, t) => n + t.replies, 0),
        sessions: sessions.length,
        activeDays: this.days.size,
        activeMs,
        toolCalls: this.toolCalls,
        thinkMs: this.thinkMs,
        linesAdded: this.linesAdded,
        tokens,
      },
      hours: this.hours,
      weekdays: this.weekdays,
      days: Object.fromEntries(this.days),
      months,
      streak,
      busiest: busiest ? { date: busiest[0], prompts: busiest[1] } : null,
      longestRun,
      projects,
      projectCount: this.projects.size,
      models: top(this.models, 5).map(([name, replies]) => ({ name, replies })),
      cost: {
        total: [...this.cost.values()].reduce((a, b) => a + b, 0),
        models: top(this.cost, 4).map(([name, usd]) => ({ name, usd })),
        unpricedTokens: this.unpriced,
        saved: Math.max(0, this.saved),
        topDay: priciest ? { date: priciest[0], usd: priciest[1] } : null,
        paid: this.paidPerMonth * months.length, // 0 when the monthly price wasn't given
      },
      actions: top(this.actions, 5).map(([name, count]) => ({ name, count })),
      persona: persona({ prompts, hours: this.hours, weekdays: this.weekdays, projects, projectCount: this.projects.size, tools }),
    };
  }
}
