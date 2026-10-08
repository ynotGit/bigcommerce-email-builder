// Project settings shared by the team: theme-emails/email-builder.json
import fs from 'node:fs';
import path from 'node:path';
import type { Config, LintSettings } from './types.js';

export const SETTINGS_FILE = 'email-builder.json';

export interface Settings {
  /** Catalog SKUs to show in preview data. Read by "email-builder fixture sku". */
  skus?: unknown;
  lint?: Partial<LintSettings>;
}

export const settingsPath = (config: Config): string => path.join(config.root, SETTINGS_FILE);

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
