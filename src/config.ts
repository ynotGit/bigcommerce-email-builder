import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Flags } from './types.js';

/** BigCommerce truncates email bodies past this many characters. */
export const BODY_LIMIT = 65536;

/** Package root, where assets/ and defaults/ live (one level above dist/). */
export const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnvFile(file: string): Record<string, string> | null {
  if (!fs.existsSync(file)) return null;
  const vars: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    vars[line.slice(0, eq).trim()] = value;
  }
  return vars;
}

/** Everything the tool reads and writes lives in this folder inside your project. */
export const WORKSPACE_DIR = 'theme-emails';

const text = (value: string | boolean | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The workspace is always ./theme-emails under the folder you run the command
 * from. Running from inside theme-emails works too.
 */
export function resolveWorkspace(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === WORKSPACE_DIR ? cwd : path.join(cwd, WORKSPACE_DIR);
}

/** A path as the user would type it from where they are standing. */
export const display = (target: string): string => path.relative(process.cwd(), target) || '.';

// ---- Environments ----------------------------------------------------------
// An environment is one store to talk to: a store hash, a token and optionally
// a channel. "default" lives in .env, any other in .env.<name>, and the file
// .active-env remembers which one commands use.

export const DEFAULT_ENV = 'default';
const ACTIVE_FILE = '.active-env';

export function assertEnvName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new Error(`"${name}" is not a usable environment name. Use letters, numbers, dashes and underscores.`);
  }
  return name;
}

export const envFilePath = (root: string, name: string): string =>
  path.join(root, name === DEFAULT_ENV ? '.env' : `.env.${name}`);

export function listEnvNames(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const names = fs
    .readdirSync(root)
    .map((file) => (file === '.env' ? DEFAULT_ENV : /^\.env\.(.+)$/.exec(file)?.[1]))
    .filter((name): name is string => Boolean(name));
  return names.sort((a, b) => (a === DEFAULT_ENV ? -1 : b === DEFAULT_ENV ? 1 : a.localeCompare(b)));
}

export function setActiveEnv(root: string, name: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ACTIVE_FILE), `${name}\n`);
}

/**
 * The environment someone has chosen, or null if nobody has.
 * --env wins, then EMAIL_BUILDER_ENV, then whatever "env use" last picked.
 * A project whose only environment is "default" needs no choosing.
 */
export function selectedEnvName(root: string, flags: Flags = {}): string | null {
  const explicit = text(flags.env) ?? text(process.env.EMAIL_BUILDER_ENV);
  if (explicit) return assertEnvName(explicit);
  const pointer = path.join(root, ACTIVE_FILE);
  const saved = fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '';
  if (saved) return saved;
  return listEnvNames(root).some((name) => name !== DEFAULT_ENV) ? null : DEFAULT_ENV;
}

/** Commands never guess between stores: with named environments, one must be chosen first. */
export function resolveEnvName(root: string, flags: Flags = {}): string {
  const selected = selectedEnvName(root, flags);
  if (selected) return selected;
  const names = listEnvNames(root);
  throw new Error(
    `No environment selected. Choose one first:\n\n  email-builder env use ${names.find((n) => n !== DEFAULT_ENV) ?? '<name>'}\n\nYou have: ${names.join(', ')}.`,
  );
}

export function loadConfig(flags: Flags = {}): Config {
  const root = resolveWorkspace();
  const envName = resolveEnvName(root, flags);
  let vars = parseEnvFile(envFilePath(root, envName));
  if (!vars && envName !== DEFAULT_ENV) {
    const known = listEnvNames(root);
    throw new Error(
      `No environment called "${envName}".${known.length ? ` You have: ${known.join(', ')}.` : ''}\nCreate it with: email-builder env add ${envName}`,
    );
  }
  // With no file for the default environment, fall back to a project-level .env
  // and then to real environment variables (useful in CI). When a file exists,
  // the store, token and channel come only from it, so a stray shell variable
  // can never redirect a publish to another store.
  const fromFile = Boolean(vars);
  vars ??= { ...(root !== process.cwd() ? parseEnvFile(path.join(process.cwd(), '.env')) : null) };
  const read = (key: string): string | undefined => text(vars[key]) ?? (fromFile ? undefined : text(process.env[key]));
  const setting = (key: string): string | undefined => text(vars[key]) ?? text(process.env[key]);

  // The channel is part of an environment, saved alongside its store hash and token.
  const channelId = read('BC_CHANNEL_ID') ?? null;
  const scope = channelId ? `channel-${channelId}` : 'global';
  return {
    root,
    envName,
    storeHash: read('BC_STORE_HASH'),
    token: read('BC_ACCESS_TOKEN'),
    apiBase: (setting('BC_API_URL') || 'https://api.bigcommerce.com').replace(/\/$/, ''),
    channelId,
    scope,
    port: Number(text(flags.port) ?? setting('PORT') ?? 4321),
    templatesDir: path.join(root, 'templates', scope),
    fixturesDir: path.join(root, 'fixtures'),
  };
}

export function requireCredentials(config: Config): asserts config is Config & { storeHash: string; token: string } {
  const missing: string[] = [];
  if (!config.storeHash) missing.push('BC_STORE_HASH');
  if (!config.token) missing.push('BC_ACCESS_TOKEN');
  if (missing.length) {
    throw new Error(`Missing ${missing.join(' and ')} for the ${config.envName} environment. Run "email-builder init" to set them up.`);
  }
}
