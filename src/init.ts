import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { listRemoteTemplates } from './api.js';
import { DEFAULT_ENV, assertEnvName, display, envFilePath, loadConfig, resolveWorkspace } from './config.js';
import type { Flags } from './types.js';

// Credentials for every environment and the per-developer "active" pointer stay out of git.
const IGNORE_LINES = ['.env', '.env.*', '.active-env'];

/** Accepts a bare hash or the API path BigCommerce shows, e.g. https://api.bigcommerce.com/stores/abc123/v3/ */
export function parseStoreHash(input: string): string {
  const trimmed = input.trim();
  return /stores\/([a-z0-9]+)/i.exec(trimmed)?.[1] ?? trimmed.replace(/^\/+|\/+$/g, '');
}

function ensureIgnored(root: string): string[] {
  const file = path.join(root, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = IGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, `${existing}${prefix}${missing.join('\n')}\n`);
  }
  return missing;
}

const flag = (value: string | boolean | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * Asks for (or takes from flags) one store's credentials, saves them as the
 * named environment and tests the connection. Returns false if the user backed out.
 */
export async function saveEnvironment(flags: Flags, name: string): Promise<boolean> {
  assertEnvName(name);
  const root = resolveWorkspace();
  const envFile = envFilePath(root, name);
  const envLabel = display(envFile);
  let storeHash = flag(flags['store-hash']);
  let token = flag(flags.token);
  let channel = flag(flags.channel);
  const interactive = !(storeHash && token);

  if (interactive && !process.stdin.isTTY) {
    throw new Error('No terminal to ask questions in. Pass --store-hash and --token instead.');
  }
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (fs.existsSync(envFile) && !flags.force) {
      if (!rl) throw new Error(`${envLabel} already exists. Pass --force to replace it.`);
      const answer = await rl.question(`${envLabel} already exists. Replace it? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log(`Left ${envLabel} as it was.`);
        return false;
      }
    }
    if (rl) {
      console.log(`Setting up the ${name} environment. Have that store's API account open (Settings > Store-level API accounts).\n`);
      storeHash ??= await rl.question('Store hash, or the API path it shows: ');
      token ??= await rl.question('Access token: ');
      channel ??= (await rl.question('Channel ID for channel-specific templates (leave blank for global): ')).trim() || undefined;
    }
  } finally {
    rl?.close();
  }

  storeHash = parseStoreHash(storeHash ?? '');
  token = (token ?? '').trim();
  if (!storeHash || !token) throw new Error('Both a store hash and an access token are needed. Nothing was written.');

  const lines = [`BC_STORE_HASH=${storeHash}`, `BC_ACCESS_TOKEN=${token}`];
  if (channel) lines.push(`BC_CHANNEL_ID=${channel}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`Wrote ${envLabel}`);
  const ignored = ensureIgnored(root);
  if (ignored.length) {
    console.log(`Updated ${display(path.join(root, '.gitignore'))} so credentials stay out of git.`);
  }

  // Check the credentials straight away so a typo surfaces here, not on the first publish.
  try {
    const templates = await listRemoteTemplates(loadConfig({ env: name }));
    console.log(`Connected. The store has ${templates.length} email template(s).`);
  } catch (err) {
    console.log(`\n${envLabel} is saved, but the test request failed:\n${(err as Error).message}`);
    process.exitCode = 1;
  }
  return true;
}

export async function init(flags: Flags): Promise<void> {
  const name = flag(flags.env) ?? DEFAULT_ENV;
  if (!(await saveEnvironment(flags, name))) return;
  if (!process.exitCode) console.log('Next: email-builder create --all');
}
