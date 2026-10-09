// Builds preview data in the shape of BigCommerce's email objects (see types.ts).
import fs from 'node:fs';
import path from 'node:path';
import { bc } from './api.js';
import { PACKAGE_ROOT } from './config.js';
import { folderName } from './names.js';
import { fixtureDir, sharedFixtureFile } from './render.js';
import type { Config, EmailInvoiceProduct, EmailProduct, Formatted, V2Store, V3Product, V3Variant } from './types.js';

const defaultsDir = path.join(PACKAGE_ROOT, 'defaults');

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Gives every template something to render against. Returns the files it created. */
export function ensureDefaultFixtures(config: Config, typeIds: string[]): string[] {
  const created: string[] = [];
  const globalFile = path.join(config.fixturesDir, '_global.json');
  if (!fs.existsSync(globalFile)) {
    fs.mkdirSync(config.fixturesDir, { recursive: true });
    fs.copyFileSync(path.join(defaultsDir, '_global.json'), globalFile);
    created.push('fixtures/_global.json');
  }
  for (const typeId of typeIds) {
    const file = path.join(fixtureDir(config, typeId), 'default.json');
    const shipped = path.join(defaultsDir, `${typeId}.json`);
    // An empty one is the placeholder written before this email had sample data, so it is filled in too.
    const placeholder = fs.existsSync(file) && fs.existsSync(shipped) && fs.readFileSync(file, 'utf8').trim() === '{}';
    if (fs.existsSync(file) && !placeholder) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(shipped)) fs.copyFileSync(shipped, file);
    else fs.writeFileSync(file, '{}\n');
    created.push(`fixtures/${folderName(typeId)}/default.json`);
  }
  return created;
}

/** An email's sample data: its default.json, or the one this tool ships if that is gone. */
function sampleData(config: Config, typeId: string): Json {
  const file = [path.join(fixtureDir(config, typeId), 'default.json'), path.join(defaultsDir, `${typeId}.json`)].find((f) => fs.existsSync(f));
  return file ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Json) : {};
}

function money(amount: string | number | undefined, currency: string | undefined): string {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

/** The store's own details: its currency for product prices, its name and logo for "fixture store". */
async function fetchStore(config: Config): Promise<V2Store> {
  const store = await bc<V2Store>(config, '/v2/store');
  if (!store) throw new Error('The store information request came back empty.');
  return store;
}

/** Looks a SKU up in the catalog: first as a product SKU, then as a variant SKU. */
async function productForSku(config: Config, sku: string, currency: string, brands: Map<number, string>): Promise<{ line: EmailProduct; value: number }> {
  const byProduct = await bc<{ data?: V3Product[] }>(config, '/v3/catalog/products', {
    query: { sku, include: 'primary_image' },
  });
  let product = byProduct?.data?.find((p) => p.sku === sku);
  let variant: V3Variant | undefined;
  if (!product) {
    const byVariant = await bc<{ data?: V3Variant[] }>(config, '/v3/catalog/variants', { query: { sku } });
    variant = byVariant?.data?.find((v) => v.sku === sku);
    if (!variant) throw new Error(`No product or variant in this store's catalog has the SKU "${sku}".`);
    const parent = await bc<{ data?: V3Product }>(config, `/v3/catalog/products/${variant.product_id}`, {
      query: { include: 'primary_image' },
    });
    product = parent?.data;
    if (!product) throw new Error(`The product for SKU "${sku}" could not be loaded.`);
  }

  let brand = '';
  if (product.brand_id) {
    if (!brands.has(product.brand_id)) {
      const res = await bc<{ data?: { name?: string } }>(config, `/v3/catalog/brands/${product.brand_id}`);
      brands.set(product.brand_id, res?.data?.name ?? '');
    }
    brand = brands.get(product.brand_id) ?? '';
  }

  const value = Number(variant?.calculated_price ?? variant?.price ?? product.calculated_price ?? product.price) || 0;
  return {
    value,
    line: {
      name: product.name,
      sku,
      price: money(value, currency),
      quantity: 1,
      thumbnail: variant?.image_url || product.primary_image?.url_thumbnail || product.primary_image?.url_standard || '',
      brand,
      attribute_lines: (variant?.option_values ?? []).map((o) => ({ name: o.option_display_name, value: o.label })),
    },
  };
}

/** The order email is the one that reads an order's products in a shape of its own. */
const ORDER_EMAIL = 'invoice_email';

/**
 * The name given to preview data becomes a file name, and two are taken:
 * _global.json and each email's default.json hold what everything else is laid
 * over. Names are compared without case, as file names are on most Macs.
 */
export function assertFixtureName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new Error(`"${name}" is not a usable name for preview data. Use letters, numbers, dashes and underscores.`);
  }
  if (['global', 'default'].includes(name.toLowerCase())) {
    throw new Error(`"${name}" is taken: it is the file that holds the preview's own sample data, which this would replace. Choose another name, for example "products".`);
  }
}

interface SkuFixtureOptions {
  /** Write one email's own fixture instead of the shared one every email can use. */
  typeId?: string;
  name?: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

interface SkuFixture {
  file: string;
  products: EmailProduct[];
  /** Emails with a fixture of the same name of their own, which they keep using instead of the shared one. */
  shadowedBy: string[];
}

/**
 * Builds preview data that shows real catalog products in otherwise made-up
 * emails. Only product data is read from the store; the customer stays the
 * sample one. Without a template it writes one shared fixture that the preview
 * lays over whichever email is open, so the products show in every email that
 * has a place for them.
 */
export async function buildSkuFixture(config: Config, skus: string[], options: SkuFixtureOptions = {}): Promise<SkuFixture> {
  const { typeId } = options;
  const name = options.name || 'products';
  const currency = (await fetchStore(config)).currency || 'USD';
  const brands = new Map<number, string>();
  const priced = (value: number): Formatted<number> => ({ value, formatted: money(value, currency) });
  const products: EmailProduct[] = [];
  const invoiced: EmailInvoiceProduct[] = [];
  let total = 0;
  for (const sku of skus) {
    const { line, value } = await productForSku(config, sku, currency, brands);
    products.push(line);
    invoiced.push({
      name: line.name, sku: line.sku, type: 'physical', brand: line.brand, thumbnail: line.thumbnail, quantity: line.quantity,
      price: priced(value), total: priced(value * line.quantity), options: [],
      attribute_lines: line.attribute_lines.map((attribute) => `${attribute.name}: ${attribute.value}`), configurable_fields: [],
    });
    total += value * line.quantity;
  }
  // The sample order's first line says where it ships to; the real products keep that address.
  const sampleOrder = sampleData(config, ORDER_EMAIL).order;
  const [sampleLine] = isObject(sampleOrder) && Array.isArray(sampleOrder.products) ? (sampleOrder.products as EmailInvoiceProduct[]) : [];
  if (invoiced[0] && sampleLine?.address_lines) invoiced[0].address_lines = sampleLine.address_lines;

  // The products, in each place an email reads them from: an order, a review request and a return.
  const placed: Record<string, Json> = {
    order: { products, unshipped_products: [], downloadable_products: [], total: priced(total) },
    review: { products: products.map((product) => ({ ...product, link: '#review' })) },
    return: { products, product: products[0] },
  };
  // The order email reads the same order in a shape of its own, with the totals as rows.
  const invoice: Json = {
    products: invoiced,
    total_rows: [
      { label: 'Subtotal', price: priced(total) },
      { label: 'Shipping', price: priced(0) },
      { label: 'Grand total', price: priced(total) },
    ],
  };

  if (!typeId) {
    const file = sharedFixtureFile(config, name);
    writeJson(file, { ...placed, [`@${folderName(ORDER_EMAIL)}`]: { order: invoice } });
    const shadowedBy = fs.existsSync(config.fixturesDir)
      ? fs.readdirSync(config.fixturesDir).filter((dir) => fs.existsSync(path.join(config.fixturesDir, dir, `${name}.json`))).sort()
      : [];
    return { file, products, shadowedBy };
  }

  // One email's own fixture starts from its sample data so everything else stays filled in.
  const data = sampleData(config, typeId);
  if (typeId === ORDER_EMAIL) Object.assign(placed.order ?? {}, invoice);
  for (const [key, value] of Object.entries(placed)) data[key] = { ...(isObject(data[key]) ? data[key] : {}), ...value };
  const file = path.join(fixtureDir(config, typeId), `${name}.json`);
  writeJson(file, data);
  return { file, products, shadowedBy: [] };
}

export interface StoreSummary {
  name: string;
  domain: string;
  logo: string;
  address: string;
}

/**
 * Replaces the sample store in _global.json with the selected environment's
 * real one, so the preview shows the store's own name and logo and can load
 * the images templates build from its CDN path. The rest of the file (the
 * sample customer, anything added by hand) is kept.
 */
export async function buildStoreFixture(config: Config): Promise<{ file: string; store: StoreSummary }> {
  const remote = await fetchStore(config);
  const file = path.join(config.fixturesDir, '_global.json');
  let data: Json;
  try {
    data = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : path.join(defaultsDir, '_global.json'), 'utf8')) as Json;
  } catch (err) {
    throw new Error(`fixtures/_global.json is not valid JSON: ${(err as Error).message}`);
  }
  const current: Json = isObject(data.store) ? data.store : {};

  const name = remote.name ?? '';
  const domain = remote.domain ?? '';
  const logo = (isObject(remote.logo) && typeof remote.logo.url === 'string' && remote.logo.url) || '';
  const address = remote.address ?? '';
  const url = remote.secure_url || (domain ? `https://${domain}` : '');
  // Derived rather than read: the logo's URL starts with the CDN path; a store without a logo is on the usual host.
  const cdnPath = /^https?:\/\/[^/]+\/s-[^/]+/i.exec(logo)?.[0] ?? `https://cdn11.bigcommerce.com/s-${config.storeHash ?? ''}`;
  data.store = {
    ...current,
    name,
    domain_name: domain,
    cdn_path: cdnPath,
    // With no logo the URL is left empty, and templates fall back to the store name as they do in a real email
    logo: { title: name, name: logo.split('?')[0]?.split('/').pop() ?? '', url: logo },
    ssl_path: url,
    path_normal: url,
    path: url,
    address,
  };
  writeJson(file, data);
  return { file, store: { name, domain, logo, address } };
}
