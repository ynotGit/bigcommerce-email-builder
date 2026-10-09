// Project settings shared by the team: theme-emails/email-builder.json
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from './config.js';
import type { Config, LintSettings } from './types.js';

export const SETTINGS_FILE = 'email-builder.json';

export interface Settings {
  /** Catalog SKUs to show in preview data. Read by "email-builder fixture sku". */
  skus?: unknown;
  lint?: Partial<LintSettings>;
}

export const settingsPath = (config: Config): string => path.join(config.root, SETTINGS_FILE);

/** Starts a project off with the shipped settings: the usual SKUs to preview with. Never replaces a file that is there. */
export function ensureSettings(config: Config): boolean {
  const file = settingsPath(config);
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(config.root, { recursive: true });
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'defaults', SETTINGS_FILE), file);
  return true;
}

export function readSettings(config: Config): Settings {
  const file = settingsPath(config);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Settings) : {};
  } catch (err) {
    throw new Error(`${SETTINGS_FILE} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Saves the list of features "lint" leaves alone. Everything else in the file is kept. */
export function writeLintIgnore(config: Config, ignore: string[]): void {
  const settings = readSettings(config);
  settings.lint = { ...settings.lint, ignore };
  // One entry per line, except a list short enough to read on one, such as the SKUs.
  const json = JSON.stringify(settings, null, 2).replace(/\[\n\s+([^[\]{}]*?)\n\s+\]/g, (list: string, items: string) => {
    const inline = `[${items.replace(/,\n\s+/g, ', ')}]`;
    return inline.length <= 80 ? inline : list;
  });
  fs.mkdirSync(config.root, { recursive: true });
  fs.writeFileSync(settingsPath(config), `${json}\n`);
}

/** The saved SKU list, tidied: strings only, no blanks, no repeats. */
export function readSkus(config: Config): string[] {
  const { skus } = readSettings(config);
  if (skus === undefined) return [];
  if (!Array.isArray(skus)) {
    throw new Error(`"skus" in ${SETTINGS_FILE} must be a list, for example: "skus": ["TOTE-NAT", "MUG-BLU"]`);
  }
  const cleaned = skus
    .filter((sku): sku is string | number => typeof sku === 'string' || typeof sku === 'number')
    .map((sku) => String(sku).trim())
    .filter(Boolean);
  return [...new Set(cleaned)];
}
