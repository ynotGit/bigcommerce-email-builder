// ---- Email Templates API -------------------------------------------------

export interface RemoteTranslation {
  locale: string;
  keys: Record<string, string>;
}

/** A template as GET/PUT /v3/marketing/email-templates represents it. */
export interface RemoteTemplate {
  type_id: string;
  body: string;
  subject: string;
  translations: RemoteTranslation[];
}

/** Phrases keyed by locale, the shape phrases.json uses on disk. */
export type TranslationMap = Record<string, Record<string, string>>;

export interface LocalTemplate {
  type_id: string;
  body: string;
  subject: string;
  translations: TranslationMap;
}

export type TemplatePart = 'body' | 'subject' | 'phrases';

// ---- Tool configuration --------------------------------------------------

export interface Config {
  root: string;
  /** Which saved store this run talks to: "default", "staging", ... */
  envName: string;
  storeHash: string | undefined;
  token: string | undefined;
  apiBase: string;
  channelId: string | null;
  /** "global" or "channel-<id>"; also the folder name under templates/. */
  scope: string;
  port: number;
  templatesDir: string;
  fixturesDir: string;
}

export type Flags = Record<string, string | boolean | undefined>;

// ---- Email objects -------------------------------------------------------
// The data BigCommerce hands to a template. Reference:
// https://docs.bigcommerce.com/developer/docs/admin/store-configuration/emails/email-object-reference/global-email-object

export interface Formatted<T> {
  value: T;
  formatted: string | null;
}

export interface AttributeLine {
  name: string;
  value: string;
}

export interface EmailProduct {
  name: string;
  sku: string;
  price: string;
  quantity: number;
  thumbnail: string;
  brand: string;
  attribute_lines: AttributeLine[];
}

/** A line in the order email, which prices and describes a product differently from the other emails. */
export interface EmailInvoiceProduct {
  name: string;
  sku: string;
  type: 'physical' | 'digital';
  brand: string;
  thumbnail: string;
  quantity: number;
  price: Formatted<number>;
  total: Formatted<number>;
  options: string[];
  /** Already text here, "Color: Red", where the other emails get a name and a value. */
  attribute_lines: string[];
  configurable_fields: AttributeLine[];
  /** Where the line ships to. Absent on a line that shares the address above it. */
  address_lines?: string[];
}

// ---- The slices of the Store and Catalog APIs the fixtures read ---------------
// No order or customer endpoints: preview data never includes personal data.

export interface V2Store {
  name?: string;
  domain?: string;
  secure_url?: string;
  address?: string;
  currency?: string;
  /** An object when the store has a logo; anything else means it has none. */
  logo?: { url?: string } | unknown[];
}

export interface V3ProductImage {
  url_thumbnail?: string;
  url_standard?: string;
}

export interface V3Product {
  id: number;
  name: string;
  sku: string;
  price: number;
  calculated_price?: number;
  brand_id?: number;
  primary_image?: V3ProductImage;
}

export interface V3Variant {
  id: number;
  product_id: number;
  sku: string;
  price?: number | null;
  calculated_price?: number | null;
  image_url?: string;
  option_values?: { option_display_name: string; label: string }[];
}

// ---- Email client compatibility ---------------------------------------------

export interface LintSettings {
  /** Client names or globs from caniemail.com, e.g. "outlook.*" or "gmail.ios". */
  clients: string[];
  /** Feature titles to stop reporting, e.g. "border-radius". */
  ignore: string[];
}

export interface CompatIssue {
  /** 1-based position in body.html; 0 when the checker could not place it. */
  line: number;
  column: number;
  /** The feature as caniemail.com names it, e.g. "display:flex". */
  title: string;
  level: 'unsupported' | 'partial';
  clients: string[];
  notes: string[];
}

// ---- Rendering -------------------------------------------------------------

export interface RenderRequest {
  typeId: string | null;
  fixture?: string;
  locale?: string;
}

export interface RenderResult {
  typeId: string | null;
  html: string;
  subject: string;
  warnings: string[];
  error: string | null;
  length: number;
  limit: number;
  locale: string | null;
}
