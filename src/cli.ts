#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { listRemoteTemplates, putRemoteTemplate } from './api.js';
import {
  BODY_LIMIT, DEFAULT_ENV, PACKAGE_ROOT, WORKSPACE_DIR, display, envFilePath, listEnvNames, loadConfig, resolveWorkspace, selectedEnvName,
} from './config.js';
import { buildSkuFixture, buildStoreFixture, ensureDefaultFixtures } from './fixtures.js';
import { env } from './env.js';
import { init, saveEnvironment } from './init.js';
import { lintTemplate, readLintSettings, summariseClients } from './lint.js';
import { checkSyntax } from './render.js';
import { startServer } from './server.js';
import { SETTINGS_FILE, ensureSettings, readSkus, settingsPath } from './settings.js';
import { diffTemplate, listLocalTemplates, readLocalTemplate, toApiPayload, writeLocalTemplate } from './store.js';
import type { Config, Flags, LocalTemplate, RemoteTemplate, TemplatePart } from './types.js';

const HELP = `Usage: email-builder <command>

First time
  setup <environment...>   Save store credentials and download the templates
  env use <environment>    Choose which store commands point at

Every day
  start                    Preview locally; reloads when you save
  publish <template>       Send a template to the store (asks first)

Extras
  status                   List templates that differ from the store
  lint                     Flag HTML and CSS that email clients do not support
  fixture sku              Show the products from your "skus" list in the preview
  fixture store            Show the store's own name and logo in the preview
  env                      List environments; * marks the selected one

Add --env <environment> to run one command against another store.
Files live in ./${WORKSPACE_DIR}. Every command and option: docs/REFERENCE.md
`;

const VALUE_FLAGS = new Set(['dir', 'env', 'channel', 'port', 'template', 'name', 'store-hash', 'token']);
const SHORT_FLAGS: Record<string, string> = { '-h': '--help', '-v': '--version', '-y': '--yes' };

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = SHORT_FLAGS[argv[i] ?? ''] ?? argv[i] ?? '';
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [key = '', inline] = arg.slice(2).split('=');
    if (VALUE_FLAGS.has(key)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
      flags[key] = value;
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

/** "templates/global/order_email/" and "order_email" both name the same template. */
const toTypeId = (arg: string): string => path.basename(arg.replace(/[\\/]+$/, ''));

const where = (config: Config): string => (config.channelId ? `channel ${config.channelId}` : 'the global templates');

/** Printed before anything talks to a store, so the target is never a surprise. */
const announce = (config: Config): void =>
  console.log(`Environment ${config.envName}: store ${config.storeHash ?? '(not set)'}, ${config.channelId ? `channel ${config.channelId}` : 'global templates'}\n`);
const count = (n: number): string => n.toLocaleString('en-US');

async function create(config: Config, flags: Flags, args: string[]): Promise<void> {
  const remote = await listRemoteTemplates(config);
  const names = remote.map((t) => t.type_id).sort();
  if (!remote.length) return console.log(`The store returned no templates for ${where(config)}.`);

  let wanted: RemoteTemplate[];
  if (flags.all) {
    wanted = remote;
  } else {
    const ids = args.map(toTypeId);
    if (!ids.length) {
      return console.log(`Name a template to download, or pass --all. The store has:\n  ${names.join('\n  ')}`);
    }
    const unknown = ids.filter((id) => !names.includes(id));
    if (unknown.length) {
      throw new Error(`The store has no template called ${unknown.join(', ')}. It has:\n  ${names.join('\n  ')}`);
    }
    wanted = remote.filter((t) => ids.includes(t.type_id));
  }

  let written = 0;
  const skipped: string[] = [];
  for (const template of wanted) {
    const local = readLocalTemplate(config, template.type_id);
    const changed = local ? diffTemplate(local, template) : [];
    if (local && changed.length && !flags.force) { skipped.push(template.type_id); continue; }
    if (!local || changed.length) { writeLocalTemplate(config, template); written++; }
  }
  const fixtures = ensureDefaultFixtures(config, wanted.map((t) => t.type_id));
  const starterSettings = ensureSettings(config);
  console.log(`Downloaded ${wanted.length} template(s) from ${where(config)} into ${display(config.templatesDir)}: ${written} written, ${wanted.length - written - skipped.length} already up to date.`);
  if (skipped.length) {
    console.log(`\nKept your local edits to:\n  ${skipped.join('\n  ')}\nAdd --force to overwrite them with the store's version.`);
  }
  if (fixtures.length) console.log(`\nCreated ${fixtures.length} starter fixture file(s) in ${display(config.fixturesDir)}.`);
  if (starterSettings) console.log(`Created ${display(settingsPath(config))} with a starter "skus" list for the preview.`);
  const first = wanted[0];
  if (first && !flags.chained) console.log(`\nNext: email-builder start ${wanted.length === 1 ? first.type_id : ''}`.trimEnd());
}

interface Comparison {
  typeId: string;
  local?: LocalTemplate;
  changed: TemplatePart[];
  problem?: string;
}

async function compare(config: Config, typeIds: string[]): Promise<Comparison[]> {
  const remote = new Map((await listRemoteTemplates(config)).map((t) => [t.type_id, t]));
  return typeIds.map((typeId): Comparison => {
    const local = readLocalTemplate(config, typeId);
    if (!local) return { typeId, changed: [], problem: `no local template at ${display(path.join(config.templatesDir, typeId))}` };
    const row: Comparison = { typeId, local, changed: diffTemplate(local, remote.get(typeId)) };
    const syntax = checkSyntax(local);
    if (syntax) {
      row.problem = `Handlebars syntax error: ${syntax.split('\n')[0]}`;
    } else if (local.body.length > BODY_LIMIT) {
      row.problem = `body is ${count(local.body.length)} characters; BigCommerce truncates past ${count(BODY_LIMIT)}`;
    }
    return row;
  });
}

async function status(config: Config): Promise<void> {
  const rows = await compare(config, listLocalTemplates(config));
  const changed = rows.filter((r) => r.changed.length || r.problem);
  if (!changed.length) return console.log(`Nothing to publish. Local templates match ${where(config)}.`);
  for (const r of changed) {
    const parts = r.changed.length ? `changed: ${r.changed.join(', ')}` : '';
    console.log(`  ${r.typeId}  ${parts}${r.problem ? `  [${r.problem}]` : ''}`);
  }
}

async function publish(config: Config, flags: Flags, args: string[]): Promise<void> {
  if (!args.length && !flags.all) throw new Error('Name the templates to publish, or pass --all for every changed one.');
  const rows = await compare(config, flags.all ? listLocalTemplates(config) : args.map(toTypeId));
  const blocked = rows.filter((r) => r.problem);
  const ready = rows.filter((r) => !r.problem && r.changed.length);

  for (const r of blocked) console.log(`  blocked  ${r.typeId}: ${r.problem}`);
  for (const r of ready) console.log(`  publish  ${r.typeId} (${r.changed.join(', ')})`);
  if (blocked.length) throw new Error('Fix the blocked templates first. Nothing was published.');
  const compat = ready.reduce((total, r) => total + lintTemplate(config, r.typeId).length, 0);
  if (compat) console.log(`\n${compat} feature(s) in these templates are not supported by some email clients. See them with: email-builder lint`);
  if (!ready.length) return console.log(`Nothing to publish. These templates already match ${where(config)}.`);
  if (flags['dry-run']) return console.log('\nDry run. Nothing was published.');

  if (!flags.yes) {
    if (!process.stdin.isTTY) throw new Error('Not publishing without confirmation. Pass --yes to publish from a script.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nThis replaces ${ready.length} live template(s) in the ${config.envName} environment (store ${config.storeHash}, ${where(config)}). Publish? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing was published.');
  }
  for (const r of ready) {
    if (!r.local) continue;
    await putRemoteTemplate(config, toApiPayload(r.local));
    console.log(`  published  ${r.typeId}`);
  }
}

/** Prints compatibility problems per template. Returns how many unsupported features it found. */
function lint(config: Config, flags: Flags, args: string[]): number {
  const local = listLocalTemplates(config);
  const typeIds = args.length ? args.map(toTypeId) : local;
  const unknown = typeIds.filter((id) => !local.includes(id));
  if (unknown.length) throw new Error(`No local template called ${unknown.join(', ')}.`);
  if (!typeIds.length) {
    console.log('No templates to check yet. Run "email-builder create --all" first.');
    return 0;
  }

  const settings = readLintSettings(config);
  let unsupported = 0;
  let partial = 0;
  for (const typeId of typeIds) {
    const issues = lintTemplate(config, typeId, { partial: Boolean(flags.partial) });
    if (!issues.length) continue;
    console.log(display(path.join(config.templatesDir, typeId, 'body.html')));
    for (const issue of issues) {
      if (issue.level === 'unsupported') unsupported++; else partial++;
      const where = issue.line ? `${issue.line}:${issue.column}` : '-';
      const verb = issue.level === 'unsupported' ? 'not supported in' : 'partial support in';
      console.log(`  ${where.padEnd(8)} ${issue.title}  ${verb} ${summariseClients(issue.clients)}`);
    }
    console.log('');
  }
  const checked = `Checked ${typeIds.length} template(s) against ${settings.clients.length} email client(s) using caniemail.com data.`;
  if (!unsupported && !partial) console.log(`${checked} No problems found.`);
  else console.log(`${checked}\n${unsupported} unsupported feature(s)${flags.partial ? `, ${partial} partly supported` : ''}.`);
  return unsupported;
}

async function fixture(config: Config, flags: Flags, args: string[]): Promise<void> {
  const [kind, ...typed] = args;
  if (kind === 'sku') {
    // SKUs come only from the team's settings file, so everyone previews the same products.
    if (typed.length) {
      throw new Error(`SKUs are not set on the command line. Put them in the "skus" list in ${display(settingsPath(config))} and run "email-builder fixture sku".`);
    }
    const skus = readSkus(config);
    if (!skus.length) {
      throw new Error(
        `No SKUs to look up. Add a list to ${display(settingsPath(config))}:\n\n  { "skus": ["TOTE-NAT", "MUG-BLU"] }\n\nthen run "email-builder fixture sku" again.`,
      );
    }
    console.log(`Looking up ${skus.length} SKU(s) from ${SETTINGS_FILE} in the store's catalog.`);
    const { file, products } = await buildSkuFixture(config, skus, {
      typeId: typeof flags.template === 'string' ? toTypeId(flags.template) : undefined,
      name: typeof flags.name === 'string' ? flags.name : undefined,
    });
    for (const p of products) console.log(`  ${p.sku}  ${p.name}  ${p.price}`);
    const name = path.basename(file, '.json');
    return console.log(`\nWrote ${display(file)}\nChoose "${name}" under Preview data to see ${products.length === 1 ? 'it' : 'them'} in the email. The customer in it is sample data.`);
  }
  if (kind === 'store') {
    const { file, store } = await buildStoreFixture(config);
    console.log(`  name     ${store.name}`);
    console.log(`  domain   ${store.domain}`);
    console.log(`  logo     ${store.logo || '(none set, so emails show the store name)'}`);
    console.log(`  address  ${store.address.replace(/\s*\r?\n\s*/g, ', ')}`);
    return console.log(`\nWrote ${display(file)}\nEvery preview now shows the ${config.envName} environment's store. The customer is still sample data.`);
  }
  throw new Error('The fixture commands are "email-builder fixture sku" and "email-builder fixture store".');
}

/**
 * One command for a new machine or a new teammate: credentials, environment,
 * templates and preview data. Safe to rerun; it skips what is already done and
 * never overwrites local template edits.
 */
async function setup(flags: Flags, args: string[]): Promise<void> {
  const names = args.length ? args : [typeof flags.env === 'string' ? flags.env : DEFAULT_ENV];
  const [name = DEFAULT_ENV] = names;
  const root = resolveWorkspace();
  if (names.length > 1 && (flags['store-hash'] || flags.token)) {
    throw new Error('--store-hash and --token describe one store. With several environments, run setup without them and answer the questions for each.');
  }

  console.log(`Step 1 of 3: credentials for ${names.join(', ')}`);
  for (const each of names) {
    if (listEnvNames(root).includes(each) && !flags['store-hash'] && !flags.token) {
      console.log(`${each}: already saved. Rerun "email-builder env add ${each} --force" to replace it.`);
      continue;
    }
    const saved = await saveEnvironment(flags, each);
    if (!saved) return console.log('\nSetup stopped.');
    if (process.exitCode) {
      // Do not keep credentials that failed, so the next run asks for them again.
      fs.rmSync(envFilePath(root, each), { force: true });
      return console.log(`\nSetup stopped and the ${each} credentials were not kept. Fix the problem above and run it again.`);
    }
  }
  // Setup never chooses an environment for you. It only borrows the first one
  // named to download from; picking where commands point is left as an explicit step.
  const config = loadConfig({ ...flags, env: name });

  console.log(`\nStep 2 of 3: templates, downloaded from ${name} (store ${config.storeHash})`);
  await create(config, { all: true, chained: true }, []);

  // Preview data is a nicety: a missing scope or SKU here should not stop the setup.
  console.log('\nStep 3 of 3: catalog products for the preview');
  if (!readSkus(config).length) {
    console.log(`Skipped: no "skus" list in ${display(settingsPath(config))} yet.`);
  } else {
    try {
      await fixture(config, {}, ['sku']);
    } catch (err) {
      console.log(`Skipped: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  const active = selectedEnvName(root);
  if (active) return console.log(`\nSetup complete. ${active} is the selected environment. Next: email-builder start`);
  console.log(`\nSetup complete. Nothing is selected yet, so choose an environment before you start:\n\n  email-builder env use ${name}\n  email-builder start`);
}

async function start(config: Config, args: string[]): Promise<void> {
  const local = listLocalTemplates(config);
  const typeId = args[0] ? toTypeId(args[0]) : undefined;
  if (typeId && !local.includes(typeId)) {
    throw new Error(`No local template called ${typeId}. Download it first: email-builder create ${typeId}`);
  }
  const { url } = await startServer(config);
  console.log(`Starting email-builder at ${url}${typeId ? `/#type=${typeId}` : ''}`);
  console.log(`Environment ${config.envName}. Previewing ${local.length} template(s) from ${display(config.templatesDir)}. Press Ctrl+C to stop.`);
  if (!local.length) console.log('No templates yet. Run "email-builder create --all" in another terminal.');
}

function version(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (command === '-v' || command === '--version' || flags.version) return console.log(version());
  if (!command || command === 'help' || command === '-h' || command === '--help' || flags.help) return console.log(HELP);
  if (flags.dir) throw new Error(`--dir is not an option. Files always live in ./${WORKSPACE_DIR}.`);
  if (flags.channel && !['init', 'setup', 'env'].includes(command)) {
    throw new Error('--channel is not an option here. A channel belongs to an environment: set it when you save one with "email-builder env add <name>", then select that environment.');
  }
  if (command === 'init') return init(flags);
  if (command === 'env') return env(flags, positional);
  if (command === 'setup') return setup(flags, positional);

  const config = loadConfig(flags);
  if (['create', 'publish', 'status', 'fixture'].includes(command)) announce(config);
  switch (command) {
    case 'create': return create(config, flags, positional);
    case 'start': return start(config, positional);
    case 'publish': return publish(config, flags, positional);
    case 'status': return status(config);
    case 'lint':
      // A non-zero exit lets CI fail a pull request that adds unsupported markup.
      if (lint(config, flags, positional)) process.exitCode = 1;
      return undefined;
    case 'fixture': return fixture(config, flags, positional);
    default:
      console.log(HELP);
      throw new Error(`Unknown command "${command}".`);
  }
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
