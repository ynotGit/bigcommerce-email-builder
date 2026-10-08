import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { BODY_LIMIT, display } from './config.js';
import { readLocalTemplate } from './store.js';
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

export function listFixtures(config: Config, typeId: string): string[] {
  const dir = path.join(config.fixturesDir, typeId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5))
    .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
}

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
      warn(`No "${key}" phrase for locale "${locale}" in translations.json`);
      return key;
    }
    const args = (options?.hash ?? {}) as Json;
    return String(phrase).replace(/\{(\w+)\}/g, (match, name: string) => {
      if (name in args) return String(args[name] ?? '');
      warn(`Phrase "${key}" expects {${name}}, but the template does not pass it`);
      return match;
    });
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
    if (!template) throw new Error(`No template at ${display(path.join(config.templatesDir, typeId, 'body.html'))}`);
    result.length = template.body.length;
    if (result.length > BODY_LIMIT) {
      warn(`Body is ${result.length.toLocaleString('en-US')} characters. BigCommerce truncates past ${BODY_LIMIT.toLocaleString('en-US')}.`);
    }

    const context = deepMerge(
      readJson(path.join(config.fixturesDir, '_global.json'), 'fixtures/_global.json'),
      readJson(path.join(config.fixturesDir, typeId, `${fixture}.json`), `fixtures/${typeId}/${fixture}.json`),
    ) as Json;
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
