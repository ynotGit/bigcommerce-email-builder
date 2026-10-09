// Checks a template's HTML and CSS against caniemail.com's support data
// (bundled in the `caniemail` package) and reports what the email clients you
// care about cannot render.
import { caniemail, rawData, type CanIEmailOptions } from 'caniemail';
import { readSettings } from './settings.js';
import { readLocalTemplate } from './store.js';
import type { CompatIssue, Config, LintSettings } from './types.js';

type ClientGlobs = CanIEmailOptions['clients'];

/** The clients most stores' customers read mail in. Override in email-builder.json. */
export const DEFAULT_CLIENTS = [
  'gmail.desktop-webmail', 'gmail.ios', 'gmail.android',
  'outlook.windows', 'outlook.outlook-com', 'outlook.macos', 'outlook.ios', 'outlook.android',
  'apple-mail.macos', 'apple-mail.ios',
  'yahoo.desktop-webmail', 'yahoo.ios', 'yahoo.android',
  'samsung-email.android',
];

/** Reported for every email and not something a template can fix. */
export const DEFAULT_IGNORE = ['<body> element'];

export function readLintSettings(config: Config): LintSettings {
  const { lint } = readSettings(config);
  return {
    clients: Array.isArray(lint?.clients) && lint.clients.length ? lint.clients : DEFAULT_CLIENTS,
    ignore: Array.isArray(lint?.ignore) ? lint.ignore : DEFAULT_IGNORE,
  };
}

// caniemail.com has no data for some feature and client pairs (word-wrap on
// Gmail for iOS, for one), and the library's check throws on them, failing the
// whole email. Its own feature listing skips such pairs, so the check does the
// same: each gap is filled in as supported, which reports nothing.
type Stats = Record<string, Record<string, Record<string, string>>>;
const allStats = rawData.data.map((feature) => feature.stats as Stats);
const platformsByFamily = new Map<string, Set<string>>();
for (const stats of allStats) {
  for (const [family, platforms] of Object.entries(stats)) {
    const known = platformsByFamily.get(family) ?? new Set<string>();
    for (const platform of Object.keys(platforms)) known.add(platform);
    platformsByFamily.set(family, known);
  }
}
for (const stats of allStats) {
  for (const [family, platforms] of platformsByFamily) {
    for (const platform of platforms) (stats[family] ??= {})[platform] ??= { 'no-data': 'y' };
  }
}

/** Same length, same line breaks, no content: keeps every line and column where it was. */
const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/** Handlebars tags are not HTML or CSS, so hide them from the checker without moving anything. */
const hideHandlebars = (source: string): string =>
  source.replace(/\{\{\{[\s\S]*?\}\}\}|\{\{[\s\S]*?\}\}/g, blank);

function lineAndColumn(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

interface Found {
  line: number;
  column: number;
  title: string;
  level: CompatIssue['level'];
  client: string;
  notes: string[];
}

function check(input: { html?: string; css?: string }, clients: string[]): Found[] {
  const { issues } = caniemail({ clients: clients as ClientGlobs, ...input });
  const found: Found[] = [];
  const levels = [['unsupported', issues.errors], ['partial', issues.warnings]] as const;
  for (const [level, byClient] of levels) {
    for (const [client, list] of byClient) {
      for (const issue of list) {
        found.push({
          line: issue.position?.start.line ?? 0,
          column: issue.position?.start.column ?? 0,
          title: issue.title,
          level,
          client,
          notes: issue.notes,
        });
      }
    }
  }
  return found;
}

export interface LintOptions extends LintSettings {
  /** Also report features that only partly work. Off by default: it is a long list. */
  partial?: boolean;
}

export function lintSource(source: string, options: LintOptions): CompatIssue[] {
  const clean = hideHandlebars(source);
  const found: Found[] = [];

  // <style> blocks are checked one at a time so their line numbers can be
  // mapped back to the file; the HTML pass then sees them emptied out.
  let html = clean;
  for (const match of clean.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = match[1] ?? '';
    const start = match.index + match[0].indexOf('>') + 1;
    const origin = lineAndColumn(clean, start);
    html = html.slice(0, start) + blank(css) + html.slice(start + css.length);
    if (!css.trim()) continue;
    for (const item of check({ css }, options.clients)) {
      if (item.line === 0) {
        found.push({ ...item, line: origin.line, column: origin.column }); // at-rules carry no position
      } else {
        found.push({
          ...item,
          line: origin.line + item.line - 1,
          column: item.line === 1 ? origin.column + item.column - 1 : item.column,
        });
      }
    }
  }
  found.push(...check({ html }, options.clients));

  const ignored = new Set(options.ignore.map((title) => title.toLowerCase()));
  const merged = new Map<string, CompatIssue>();
  for (const item of found) {
    if (item.level === 'partial' && !options.partial) continue;
    if (ignored.has(item.title.toLowerCase())) continue;
    const key = `${item.line}:${item.column}:${item.level}:${item.title}`;
    const issue = merged.get(key) ?? {
      line: item.line, column: item.column, title: item.title, level: item.level, clients: [], notes: [],
    };
    if (!issue.clients.includes(item.client)) issue.clients.push(item.client);
    for (const note of item.notes) if (!issue.notes.includes(note)) issue.notes.push(note);
    merged.set(key, issue);
  }
  return [...merged.values()]
    .map((issue) => ({ ...issue, clients: issue.clients.sort() }))
    .sort((a, b) => a.line - b.line || a.column - b.column || a.title.localeCompare(b.title));
}

export function lintTemplate(config: Config, typeId: string, options: { partial?: boolean } = {}): CompatIssue[] {
  const template = readLocalTemplate(config, typeId);
  if (!template) return [];
  return lintSource(template.body, { ...readLintSettings(config), ...options });
}

/** "outlook.windows, outlook.macos, gmail.ios" reads better as "gmail (ios), outlook (macos, windows)". */
export function summariseClients(clients: string[]): string {
  const families = new Map<string, string[]>();
  for (const client of clients) {
    const [family = client, platform = ''] = client.split('.');
    families.set(family, [...(families.get(family) ?? []), platform]);
  }
  return [...families].map(([family, platforms]) => `${family} (${platforms.join(', ')})`).join(', ');
}
