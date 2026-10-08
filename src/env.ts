import {
  DEFAULT_ENV, assertEnvName, envFilePath, listEnvNames, parseEnvFile,
  resolveWorkspace, selectedEnvName, setActiveEnv,
} from './config.js';
import { saveEnvironment } from './init.js';
import type { Flags } from './types.js';

function describe(root: string, name: string): string {
  const vars = parseEnvFile(envFilePath(root, name)) ?? {};
  const channel = vars.BC_CHANNEL_ID ? `channel ${vars.BC_CHANNEL_ID}` : 'global templates';
  return `store ${vars.BC_STORE_HASH || '(not set)'}, ${channel}`;
}

function list(root: string, flags: Flags): void {
  const names = listEnvNames(root);
  if (!names.length) return console.log('No environments yet. Run "email-builder init" to set up the first one.');
  const active = selectedEnvName(root, flags);
  const width = Math.max(...names.map((n) => n.length));
  for (const name of names) {
    console.log(`${name === active ? '*' : ' '} ${name.padEnd(width)}  ${describe(root, name)}`);
  }
  if (!active) console.log(`\nNone selected. Choose one with: email-builder env use ${names.find((n) => n !== DEFAULT_ENV) ?? names[0]}`);
  else if (!names.includes(active)) console.log(`\nThe active environment "${active}" has no saved credentials.`);
}

function use(root: string, name: string | undefined): void {
  if (!name) throw new Error('Name the environment to switch to, for example: email-builder env use staging');
  assertEnvName(name);
  const names = listEnvNames(root);
  if (!names.includes(name)) {
    throw new Error(
      `No environment called "${name}".${names.length ? ` You have: ${names.join(', ')}.` : ''}\nCreate it with: email-builder env add ${name}`,
    );
  }
  setActiveEnv(root, name);
  console.log(`Now using ${name}: ${describe(root, name)}.\nEvery command targets it until you switch again.`);
}

async function add(flags: Flags, name: string | undefined): Promise<void> {
  if (!name) throw new Error('Name the environment to add, for example: email-builder env add staging');
  if (!(await saveEnvironment(flags, name))) return;
  if (name !== DEFAULT_ENV) console.log(`Switch to it with: email-builder env use ${name}`);
}

export async function env(flags: Flags, args: string[]): Promise<void> {
  const root = resolveWorkspace();
  const [action, name] = args;
  switch (action) {
    case undefined:
    case 'list': return list(root, flags);
    case 'use': return use(root, name);
    case 'add': return add(flags, name);
    default: throw new Error(`Unknown env action "${action}". Use "env list", "env use <name>" or "env add <name>".`);
  }
}
