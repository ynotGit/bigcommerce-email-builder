// Templates on disk, in a folder named after the email as the admin lists it (see names.ts):
//   templates/<scope>/<email>/body.html
//   templates/<scope>/<email>/subject.hbs
//   templates/<scope>/<email>/translations.json   { "en": { "key": "phrase" } }
import fs from 'node:fs';
import path from 'node:path';
import { folderName, toTypeId } from './names.js';
import type { Config, LocalTemplate, RemoteTemplate, RemoteTranslation, TemplatePart, TranslationMap } from './types.js';

const readIf = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

export function translationsToMap(list: RemoteTranslation[] | undefined): TranslationMap {
  const map: TranslationMap = {};
  for (const entry of list ?? []) map[entry.locale] = entry.keys ?? {};
  return map;
}

export function translationsToList(map: TranslationMap): RemoteTranslation[] {
  return Object.entries(map).map(([locale, keys]) => ({ locale, keys }));
}

/** Where one email's files live. */
export const templateDir = (config: Config, typeId: string): string => path.join(config.templatesDir, folderName(typeId));

/** The type IDs of the emails on disk, in folder order. */
export function listLocalTemplates(config: Config): string[] {
  if (!fs.existsSync(config.templatesDir)) return [];
  const folders = fs
    .readdirSync(config.templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(config.templatesDir, entry.name, 'body.html')))
    .map((entry) => entry.name)
    .sort();
  return [...new Set(folders.map(toTypeId))];
}

export function readLocalTemplate(config: Config, typeId: string): LocalTemplate | null {
  const dir = templateDir(config, typeId);
  const body = readIf(path.join(dir, 'body.html'));
  if (body === null) return null;
  const rawTranslations = readIf(path.join(dir, 'translations.json'));
  let translations: TranslationMap = {};
  if (rawTranslations) {
    try {
      translations = JSON.parse(rawTranslations) as TranslationMap;
    } catch (err) {
      throw new Error(`${folderName(typeId)}/translations.json is not valid JSON: ${(err as Error).message}`);
    }
  }
  return {
    type_id: typeId,
    body,
    // A trailing newline in the file is an editor artifact, not part of the subject
    subject: (readIf(path.join(dir, 'subject.hbs')) ?? '').replace(/\r?\n$/, ''),
    translations,
  };
}

export function writeLocalTemplate(config: Config, remote: RemoteTemplate): void {
  const dir = templateDir(config, remote.type_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'body.html'), remote.body ?? '');
  fs.writeFileSync(path.join(dir, 'subject.hbs'), `${remote.subject ?? ''}\n`);
  fs.writeFileSync(
    path.join(dir, 'translations.json'),
    `${JSON.stringify(translationsToMap(remote.translations), null, 2)}\n`,
  );
}

const withSortedKeys = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/** Which parts of the local template differ from what the store has. */
export function diffTemplate(local: LocalTemplate, remote: RemoteTemplate | undefined): TemplatePart[] {
  if (!remote) return ['body', 'subject', 'translations'];
  const changed: TemplatePart[] = [];
  if (local.body !== (remote.body ?? '')) changed.push('body');
  if (local.subject !== (remote.subject ?? '')) changed.push('subject');
  if (withSortedKeys(local.translations) !== withSortedKeys(translationsToMap(remote.translations))) {
    changed.push('translations');
  }
  return changed;
}

export function toApiPayload(local: LocalTemplate): RemoteTemplate {
  return {
    type_id: local.type_id,
    body: local.body,
    subject: local.subject,
    translations: translationsToList(local.translations),
  };
}
