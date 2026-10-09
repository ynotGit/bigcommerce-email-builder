import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { BODY_LIMIT, display } from './config.js';
import { folderName, PHRASES_FILE } from './names.js';
import { readLocalTemplate, templateDir } from './store.js';
import type { Config, LocalTemplate, RenderRequest, RenderResult, TranslationMap } from './types.js';

type Json = Record<string, unknown>;
type HandlebarsInstance = typeof Handlebars;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function deepMerge(base: unknown, extra: unknown): unknown {
  if (!isObject(base) || !isObject(extra)) return extra === undefined ? base : extra;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = deepMerge(base[key], value);
  return out;
}

function readJson(file: string, label: string): Json {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Where one email's own fixtures live. */
export const fixtureDir = (config: Config, typeId: string): string => path.join(config.fixturesDir, folderName(typeId));

/** A fixture every email can use sits beside _global.json: fixtures/_products.json is "products". */
export const sharedFixtureFile = (config: Config, name: string): string => path.join(config.fixturesDir, `_${name}.json`);

const jsonNames = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)) : [];

/** An email's own fixtures plus the shared ones, which are offered for every email. */
export function listFixtures(config: Config, typeId: string): string[] {
  const own = jsonNames(fixtureDir(config, typeId));
  const shared = jsonNames(config.fixturesDir)
    .filter((name) => name.startsWith('_') && name !== '_global')
    .map((name) => name.slice(1));
  if (shared.length) own.push('default', ...shared);
  return [...new Set(own)].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
}

/** What BigCommerce's conditionals count as true. Unlike stock Handlebars, an empty object is false. */
const truthy = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value);

/** The operators BigCommerce's if and compare accept between two values. Only if has gtnum. */
function compare(left: unknown, operator: unknown, right: unknown, helper = 'if'): boolean {
  const [a, b] = [left as number, right as number]; // typed for the ordering operators; any value can arrive
  switch (operator) {
    case '==': return left == right;
    case '===': return left === right;
    case '!=': return left != right;
    case '!==': return left !== right;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case 'typeof': return typeof left === right;
    case 'gtnum':
      if (helper !== 'if') break;
      if (typeof left !== 'string' || typeof right !== 'string' || isNaN(Number(left)) || isNaN(Number(right))) {
        throw new Error('"if gtnum" only accepts numbers written as strings.');
      }
      return parseInt(left, 10) > parseInt(right, 10);
  }
  throw new Error(`The ${helper} helper does not know the operator "${String(operator)}".`);
}

/** Called inside another helper rather than as a block, a helper gets no fn or inverse. */
type HelperCall = Omit<Handlebars.HelperOptions, 'fn' | 'inverse'> & Partial<Pick<Handlebars.HelperOptions, 'fn' | 'inverse'>>;

interface HelperContext {
  translations: TranslationMap;
  locale: string;
  warn: (message: string) => void;
}

function buildHandlebars({ translations, locale, warn }: HelperContext): HandlebarsInstance {
  const hbs = Handlebars.create();

  // {{lang 'key' name=value}} looks the key up in the template's phrases for
  // the active locale and fills {name} placeholders from the hash arguments.
  hbs.registerHelper('lang', (key: string, options: Handlebars.HelperOptions) => {
    const phrase = translations[locale]?.[key] ?? translations.en?.[key];
    if (phrase === undefined) {
      warn(`No "${key}" phrase for locale "${locale}" in ${PHRASES_FILE}`);
      return key;
    }
    const args = (options?.hash ?? {}) as Json;
    return String(phrase).replace(/\{(\w+)\}/g, (match, name: string) => {
      if (name in args) return String(args[name] ?? '');
      warn(`Phrase "${key}" expects {${name}}, but the template does not pass it`);
      return match;
    });
  });

  // BigCommerce replaces the built-in conditionals with its own, which also take
  // a comparison, {{#if a '===' b}}, and nest inside other helpers,
  // {{#or (if a '===' b) (if c)}}. Stock Handlebars throws on both forms.
  const test = (args: unknown[], options: HelperCall): boolean => {
    const [left, middle, right] = args;
    if (args.length < 2) return truthy(left);
    // {{#if a b operator='!='}} is the older spelling of {{#if a '!=' b}}
    return args.length === 2 ? compare(left, options.hash.operator ?? '==', middle) : compare(left, middle, right);
  };
  // A block renders one of its branches. Inside another helper there is no block, and the answer is the value.
  const answer = (scope: unknown, options: HelperCall, result: boolean): unknown =>
    options.fn && options.inverse ? (result ? options.fn(scope) : options.inverse(scope)) : result;

  hbs.registerHelper('if', function (this: unknown, ...args: unknown[]) {
    const options = args.pop() as HelperCall;
    return answer(this, options, test(args, options));
  });
  hbs.registerHelper('unless', function (this: unknown, ...args: unknown[]) {
    const options = args.pop() as HelperCall;
    return answer(this, options, !test(args, options));
  });
  hbs.registerHelper('or', function (this: unknown, ...args: unknown[]) {
    const options = args.pop() as HelperCall;
    return answer(this, options, args.some(truthy));
  });

  // {{#compare a b operator='<'}} is if's comparison under an older name.
  hbs.registerHelper('compare', function (this: unknown, ...args: unknown[]) {
    const options = args.pop() as Handlebars.HelperOptions;
    if (args.length < 2) throw new Error('The compare helper needs two values to compare.');
    return compare(args[0], options.hash.operator ?? '==', args[1], 'compare') ? options.fn(this) : options.inverse(this);
  });

  // {{#replace '%%DATE%%' message}}1 May{{/replace}} prints the message with every
  // %%DATE%% swapped for the block. A message without one renders the else branch.
  hbs.registerHelper('replace', function (this: unknown, needle: unknown, haystack: unknown, options: Handlebars.HelperOptions) {
    if (typeof needle !== 'string' || typeof haystack !== 'string' || !haystack.includes(needle)) return options.inverse(this);
    return haystack.replaceAll(needle, () => options.fn(this));
  });

  // {{#eachIndex list}} walks a list with each entry in {{item}} and its position, from 0, in {{index}}.
  hbs.registerHelper('eachIndex', (list: unknown, options: Handlebars.HelperOptions) =>
    Array.isArray(list) ? list.map((item, index) => options.fn({ item, index })).join('') : '');

  // {{#for 1 30}} repeats its block with the count in {{$index}}; {{#for 30}} starts at 1.
  // An object after the numbers becomes the block's context. BigCommerce stops at 100 rounds.
  hbs.registerHelper('for', (...args: unknown[]) => {
    const options = args.pop() as Handlebars.HelperOptions;
    const scope = isObject(args.at(-1)) ? (args.pop() as Json) : {};
    const from = args.length > 1 ? parseInt(String(args[0]), 10) : 1;
    const to = Math.min(parseInt(String(args.at(-1)), 10), from + 99);
    let out = '';
    for (let i = from; i <= to; i++) out += options.fn({ ...scope, $index: i });
    return out;
  });

  // {{join list ', '}} glues a list together. limit=2 keeps the first two items
  // and lastSeparator=' and ' goes before the final one. A list missing from the
  // preview data renders empty, like any missing variable.
  hbs.registerHelper('join', (...args: unknown[]) => {
    const { hash } = args.pop() as Handlebars.HelperOptions;
    const [list, separator] = args as [unknown, string | undefined];
    if (list === undefined || list === null) return '';
    if (!Array.isArray(list)) {
      warn('The join helper was given something that is not a list, which BigCommerce rejects. Check the preview data.');
      return '';
    }
    const items: unknown[] = hash.limit ? list.slice(0, hash.limit) : list;
    if (!hash.lastSeparator) return items.join(separator);
    return items.slice(0, -1).join(separator) + hash.lastSeparator + items.slice(-1);
  });

  // Anything this tool has not implemented shows up as a warning instead of a crash.
  hbs.registerHelper('helperMissing', (...args: unknown[]) => {
    if (args.length === 1) return undefined; // a plain missing variable renders empty
    const options = args[args.length - 1] as { name: string };
    warn(`Helper "${options.name}" is not available in the local preview, so its output is missing here. Check it with a test email.`);
    return new hbs.SafeString(
      `<mark title="helper not available in the local preview">${hbs.escapeExpression(options.name)}</mark>`,
    );
  });

  return hbs;
}

export async function renderEmail(config: Config, request: RenderRequest): Promise<RenderResult> {
  const { typeId, fixture = 'default', locale } = request;
  const warnings = new Set<string>();
  const warn = (message: string) => void warnings.add(message);
  const result: RenderResult = {
    typeId, html: '', subject: '', warnings: [], error: null, length: 0, limit: BODY_LIMIT, locale: null,
  };

  try {
    if (!typeId) throw new Error('No template selected.');
    const template = readLocalTemplate(config, typeId);
    if (!template) throw new Error(`No template at ${display(path.join(templateDir(config, typeId), 'body.html'))}`);
    result.length = template.body.length;
    if (result.length > BODY_LIMIT) {
      warn(`Body is ${result.length.toLocaleString('en-US')} characters. BigCommerce truncates past ${BODY_LIMIT.toLocaleString('en-US')}.`);
    }

    // An email's own fixture is used as it is. A shared one, such as the products
    // from "fixture sku", is laid over the email's default so the rest stays filled in.
    const shared = sharedFixtureFile(config, fixture);
    const useShared = fixture !== 'global' && fs.existsSync(shared)
      && !fs.existsSync(path.join(fixtureDir(config, typeId), `${fixture}.json`));
    const own = useShared ? 'default' : fixture;
    // Emails do not all read the same data in the same shape, so a shared fixture can
    // hold a part for one email alone under "@" and its folder name: "@order-email".
    const extra = useShared ? readJson(shared, `fixtures/_${fixture}.json`) : {};
    const context = [
      readJson(path.join(fixtureDir(config, typeId), `${own}.json`), `fixtures/${folderName(typeId)}/${own}.json`),
      Object.fromEntries(Object.entries(extra).filter(([key]) => !key.startsWith('@'))),
      extra[`@${folderName(typeId)}`],
    ].reduce(deepMerge, readJson(path.join(config.fixturesDir, '_global.json'), 'fixtures/_global.json')) as Json;
    // The phrases on disk are what would be published, so they win over fixture data.
    context.translations = template.translations;
    const store = context.store as { language?: { code?: string } } | undefined;
    const active = locale || store?.language?.code || 'en';
    result.locale = active;

    const hbs = buildHandlebars({ translations: template.translations, locale: active, warn });
    result.html = hbs.compile(template.body)(context);
    result.subject = hbs.compile(template.subject, { noEscape: true })(context);
  } catch (err) {
    result.error = (err as Error).message;
  }
  result.warnings = [...warnings];
  return result;
}

/** Used by publish to stop a template that does not even parse from going live. */
export function checkSyntax(template: LocalTemplate): string | null {
  try {
    Handlebars.precompile(template.body);
    Handlebars.precompile(template.subject);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
