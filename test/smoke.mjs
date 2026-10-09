// End-to-end check of the built CLI against a mock of the BigCommerce API. Run with: npm test
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

const remote = {
  combined_order_status_email: {
    type_id: 'combined_order_status_email',
    subject: '{{lang "title"}} at {{store.name}}',
    body: `<html><head><title>t</title></head><body>
<p>{{lang 'hello' name=order.customer_name}}</p>
<p>{{{lang 'message' id=order.id status=order.new_status}}}</p>
{{#each order.products}}<li>{{name}} x{{quantity}} {{#if sku}}({{sku}}){{/if}}</li>{{/each}}
{{#if order.tracking}}{{#each order.tracking}}<a href="{{link}}">{{id}}</a>{{/each}}{{/if}}
<footer>{{misc.year}} {{store.name}}</footer></body></html>`,
    translations: [
      { locale: 'en', keys: { title: 'Order update', hello: 'Hi {name}', message: 'Order #{id} is now <strong>{status}</strong>.' } },
      { locale: 'fr', keys: { title: 'Commande', hello: 'Bonjour {name}', message: 'Commande #{id} : <strong>{status}</strong>.' } },
    ],
  },
  account_reset_password_email: {
    type_id: 'account_reset_password_email',
    subject: 'Reset your password at {{store.name}}',
    body: '<p>{{lang "reset_password" name=store.name}}</p><a href="{{account.reset_password_link}}">{{account.reset_password_link}}</a>',
    translations: [{ locale: 'en', keys: { reset_password: 'To change your password at {name} click:' } }],
  },
};
const puts = [];
const requests = []; // every API path the tool asks for

const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, store = '', p = ''] = /^\/stores\/(\w+)(\/.*)$/.exec(url.pathname) ?? [];
  if (!['testhash', 'stagehash'].includes(store)) { res.writeHead(404); return res.end('{}'); }
  requests.push(p);
  const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (req.headers['x-auth-token'] !== 'tok') return send({ title: 'unauthorized' }, 401);
  if (req.method === 'GET' && p === '/v3/marketing/email-templates') return send({ data: Object.values(remote), meta: {} });
  if (req.method === 'PUT' && p.startsWith('/v3/marketing/email-templates/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      puts.push({ store, path: p, query: url.search, body });
      remote[body.type_id] = body;
      send({ data: body });
    });
    return undefined;
  }
  if (p === '/v2/store') {
    return send(store === 'stagehash'
      ? { name: 'Stage Store', domain: 'stage.example', secure_url: 'https://stage.example', logo: [], address: '', language: 'en', currency: 'GBP' }
      : { name: 'Mock Store', domain: 'mock.example', secure_url: 'https://mock.example', logo: { url: 'https://cdn99.example/s-testhash/product_images/logo.png?t=1' }, address: '1 Mock St\nMockville', language: 'en', currency: 'GBP' });
  }
  // catalog: one SKU that is a product, one that is a variant of another product
  const tote = { id: 5, name: 'Tote', sku: 'T1', price: 20, calculated_price: 18.5, brand_id: 3, primary_image: { url_thumbnail: 'https://cdn.example/tote.jpg' } };
  const shirt = { id: 6, name: 'Shirt', sku: 'SHIRT', price: 30, primary_image: { url_thumbnail: 'https://cdn.example/shirt.jpg' } };
  if (p === '/v3/catalog/products') return send({ data: url.searchParams.get('sku') === 'T1' ? [tote] : [] });
  if (p === '/v3/catalog/variants') return send({ data: url.searchParams.get('sku') === 'SHIRT-RED-M' ? [{ id: 61, product_id: 6, sku: 'SHIRT-RED-M', price: null, image_url: 'https://cdn.example/shirt-red.jpg', option_values: [{ option_display_name: 'Color', label: 'Red' }, { option_display_name: 'Size', label: 'M' }] }] : [] });
  if (p === '/v3/catalog/products/6') return send({ data: shirt });
  if (p === '/v3/catalog/brands/3') return send({ data: { name: 'Acme' } });
  return send({ title: 'not found' }, 404);
});

await new Promise((r) => api.listen(0, '127.0.0.1', r));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'email-builder-'));
const env = { ...process.env, BC_API_URL: `http://127.0.0.1:${api.address().port}` };
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'email-builder-fresh-')); // a second, untouched project
const ws = path.join(cwd, 'theme-emails'); // the workspace the tool creates inside a project
for (const key of ['BC_STORE_HASH', 'BC_ACCESS_TOKEN', 'BC_CHANNEL_ID', 'EMAIL_BUILDER_ENV']) delete env[key];
// Async on purpose: the mock API lives in this process and must stay responsive.
const exec = promisify(execFile);
const run = async (...args) => {
  const child = exec('node', [cli, ...args], { cwd, env, timeout: 20000 });
  child.child.stdin.end(); // no terminal attached, like CI
  return (await child).stdout;
};
const fails = async (...args) => { try { await run(...args); } catch (e) { return `${e.stdout}${e.stderr}`; } throw new Error(`expected "${args.join(' ')}" to fail`); };
const tpl = (...parts) => path.join(ws, 'templates', 'global', ...parts);

try {
  // init: needs credentials, accepts a pasted API path, checks the connection, protects .env
  assert.match(await fails('status'), /Run "email-builder init"/);
  assert.match(await fails('init'), /Pass --store-hash and --token/);
  let out = await run('init', '--store-hash', 'https://api.bigcommerce.com/stores/testhash/v3/', '--token', 'tok');
  assert.match(out, /Wrote theme-emails\/\.env/);
  assert.match(out, /Connected\. The store has 2 email template/);
  assert.ok(!fs.existsSync(path.join(cwd, '.env')), 'nothing is written outside theme-emails');
  assert.match(fs.readFileSync(path.join(ws, '.env'), 'utf8'), /^BC_STORE_HASH=testhash\nBC_ACCESS_TOKEN=tok\n$/);
  assert.match(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8'), /^\.env$/m);
  assert.match(await fails('init', '--store-hash', 'x', '--token', 'y'), /already exists/);

  // create: lists what exists, downloads one by name or path, then all
  assert.match(await run('create'), /Name a template[\s\S]*account_reset_password_email\n\s+combined_order_status_email/);
  assert.match(await fails('create', 'nope_email'), /no template called nope_email/);
  out = await run('create', 'theme-emails/templates/global/account_reset_password_email/');
  assert.match(out, /Downloaded 1 template.*into theme-emails\/templates\/global: 1 written/);
  assert.ok(!fs.existsSync(tpl('combined_order_status_email')));
  out = await run('create', '--all');
  assert.match(out, /Downloaded 2 template.*1 written, 1 already up to date/);
  assert.equal(fs.readFileSync(tpl('combined_order_status_email', 'body.html'), 'utf8'), remote.combined_order_status_email.body);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(tpl('combined_order_status_email', 'translations.json')))), ['en', 'fr']);
  assert.ok(fs.existsSync(path.join(ws, 'fixtures', '_global.json')));
  assert.match(await run('status'), /Nothing to publish/);
  // the same commands work from inside theme-emails; the folder itself is not configurable
  assert.match((await exec('node', [cli, 'status'], { cwd: ws, env })).stdout, /Nothing to publish/);
  assert.match(await fails('status', '--dir', ws), /--dir is not an option\. Files always live in \.\/theme-emails/);
  assert.deepEqual(fs.readdirSync(cwd), ['theme-emails']);

  // local render
  const { loadConfig } = await import('../dist/config.js');
  const { renderEmail } = await import('../dist/render.js');
  const prev = process.cwd();
  process.chdir(cwd);
  Object.assign(process.env, env, { BC_STORE_HASH: 'testhash', BC_ACCESS_TOKEN: 'tok' });
  const config = loadConfig({});
  process.chdir(prev);
  let r = await renderEmail(config, { typeId: 'combined_order_status_email' });
  assert.equal(r.error, null);
  assert.equal(r.subject, 'Order update at Example Store');
  assert.match(r.html, /Hi Jordan Rivera/);
  assert.match(r.html, /Order #1042 is now <strong>Shipped<\/strong>/);
  assert.match(r.html, /Canvas Tote Bag x2 \(TOTE-NAT\)/);
  assert.deepEqual(r.warnings, []);
  r = await renderEmail(config, { typeId: 'combined_order_status_email', locale: 'fr' });
  assert.match(r.html, /Bonjour Jordan Rivera/);

  // warnings: unknown helper, missing phrase, missing placeholder argument
  fs.appendFileSync(tpl('account_reset_password_email', 'body.html'), '{{lang "nope"}}{{money 5}}{{lang "reset_password"}}{{missing.value}}');
  r = await renderEmail(config, { typeId: 'account_reset_password_email' });
  assert.equal(r.error, null);
  assert.equal(r.warnings.length, 3, r.warnings.join(' | '));
  assert.match(r.warnings.join(' | '), /Helper "money" is not available in the local preview/);
  // there is no way to add helpers: a helpers file in the project is ignored
  fs.writeFileSync(path.join(ws, 'helpers.local.js'), 'export default (hbs) => hbs.registerHelper("money", (n) => "$" + n);\n');
  r = await renderEmail(config, { typeId: 'account_reset_password_email' });
  assert.doesNotMatch(r.html, /\$5/);
  assert.equal(r.warnings.length, 3);
  fs.rmSync(path.join(ws, 'helpers.local.js'));

  // BigCommerce's conditionals and loop: comparisons, (if ...) inside another helper, or, unless and for
  const conditionals = (body) => {
    fs.writeFileSync(tpl('account_reset_password_email', 'body.html'), body);
    return renderEmail(config, { typeId: 'account_reset_password_email' });
  };
  r = await conditionals([
    "{{#if store.name '===' 'Example Store'}}same{{else}}differs{{/if}}",
    "{{#if misc.year '<' 2000}}old{{else}}new{{/if}}",
    "{{#or (if customer.first_name '===' 'Nope') (if misc.year '>' 2000)}}either{{else}}neither{{/or}}",
    "{{#or (if customer.first_name '===' 'Nope') missing}}either{{else}}neither{{/or}}",
    "{{#unless customer.first_name '===' 'Jordan'}}stranger{{else}}known{{/unless}}",
    "{{#if account}}account{{/if}}{{#if missing}}never{{/if}}{{#unless missing}}absent{{/unless}}",
    "{{#if 0}}zero{{else}}no zero{{/if}}",
    "{{#if store.name 'Example Store' operator='!='}}renamed{{else}}as shipped{{/if}}",
    "{{#for 1 3}}[{{$index}}]{{/for}}{{#for 2}}({{$index}}){{/for}}{{#for 1 2 customer}}<{{first_name}}{{$index}}>{{/for}}",
  ].join('|'));
  assert.equal(r.error, null);
  assert.equal(r.html, 'same|new|either|neither|known|accountabsent|no zero|as shipped|[1][2][3](1)(2)<Jordan1><Jordan2>');
  assert.deepEqual(r.warnings, []);
  assert.equal((await conditionals('{{#for 1 500}}.{{/for}}')).html.length, 100, 'a loop stops at 100 rounds, as it does at BigCommerce');
  assert.match((await conditionals("{{#if 1 'nope' 2}}x{{/if}}")).error, /does not know the operator "nope"/);

  // create keeps local edits unless forced
  out = await run('create', '--all');
  assert.match(out, /Kept your local edits to:\s+account_reset_password_email/);
  await run('create', '--all', '--force');
  assert.equal(fs.readFileSync(tpl('account_reset_password_email', 'body.html'), 'utf8'), remote.account_reset_password_email.body);

  // publish: guards, dry run, real publish
  const subjectFile = tpl('account_reset_password_email', 'subject.hbs');
  fs.writeFileSync(subjectFile, 'New subject for {{store.name}}\n');
  assert.match(await run('status'), /account_reset_password_email\s+changed: subject/);
  assert.match(await run('publish', '--all', '--dry-run'), /Dry run/);
  assert.match(await fails('publish', '--all'), /Not publishing without confirmation/);
  assert.equal(puts.length, 0);

  const bodyFile = tpl('combined_order_status_email', 'body.html');
  const goodBody = fs.readFileSync(bodyFile, 'utf8');
  fs.writeFileSync(bodyFile, '{{#if order}}unclosed');
  assert.match(await fails('publish', '--all', '--yes'), /blocked\s+combined_order_status_email: Handlebars syntax error/);
  fs.writeFileSync(bodyFile, 'x'.repeat(65537));
  assert.match(await fails('publish', '--all', '--yes'), /truncates past 65,536/);
  assert.equal(puts.length, 0, 'a blocked template must stop the whole publish');
  fs.writeFileSync(bodyFile, goodBody);

  out = await run('publish', '--all', '--yes');
  assert.match(out, /published\s+account_reset_password_email/);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/v3/marketing/email-templates/account_reset_password_email');
  assert.equal(puts[0].body.subject, 'New subject for {{store.name}}');
  assert.deepEqual(puts[0].body.translations, [{ locale: 'en', keys: { reset_password: 'To change your password at {name} click:' } }]);
  assert.match(await run('status'), /Nothing to publish/);

  // environments: a second store, switching, and a one-off override
  out = await run('env', 'add', 'staging', '--store-hash', 'stagehash', '--token', 'tok');
  assert.match(out, /Wrote theme-emails\/\.env\.staging[\s\S]*Connected[\s\S]*env use staging/);
  assert.match(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8'), /^\.env\.\*$/m);
  // with a second environment saved, nothing runs until one is chosen explicitly
  assert.match(await run('env', 'list'), / {2}default\s+store testhash, global templates\n {2}staging\s+store stagehash, global templates\n\nNone selected\. Choose one with: email-builder env use staging/);
  for (const command of [['status'], ['start'], ['lint'], ['create', '--all'], ['publish', '--all', '--yes']]) {
    assert.match(await fails(...command), /No environment selected\. Choose one first:\s+email-builder env use staging\s+You have: default, staging/, command.join(' '));
  }
  assert.match(await run('env', 'use', 'default'), /Now using default: store testhash/);
  assert.match(await run('env', 'list'), /\* default\s+store testhash/);
  assert.match(await fails('env', 'use', 'nope'), /No environment called "nope"\. You have: default, staging/);
  assert.match(await fails('status', '--env', 'nope'), /No environment called "nope"/);
  assert.match(await fails('env', 'add', '../evil', '--store-hash', 'x', '--token', 'y'), /not a usable environment name/);
  assert.match(await run('status'), /Environment default: store testhash/);
  assert.match(await run('env', 'use', 'staging'), /Now using staging: store stagehash/);
  assert.match(await run('env'), /\* staging/);
  fs.writeFileSync(subjectFile, 'Staging first\n');
  out = await run('publish', 'account_reset_password_email', '--yes');
  assert.match(out, /Environment staging: store stagehash, global templates/);
  assert.equal(puts.at(-1).store, 'stagehash');
  assert.equal(puts.at(-1).body.subject, 'Staging first');
  assert.match(await run('status', '--env', 'default'), /Environment default: store testhash/);
  // credentials in a file beat stray shell variables, so a publish cannot be redirected
  out = (await exec('node', [cli, 'status'], { cwd, env: { ...env, BC_STORE_HASH: 'testhash', BC_CHANNEL_ID: '99' } })).stdout;
  assert.match(out, /Environment staging: store stagehash, global templates/);
  await run('env', 'use', 'default');
  assert.equal(puts.filter((p) => p.store === 'testhash').length, 1, 'the default store saw no extra writes');

  // a channel belongs to an environment: its own template folder and query parameter
  assert.match(await fails('create', '--all', '--channel', '12'), /--channel is not an option here\. A channel belongs to an environment/);
  await run('env', 'add', 'storefront', '--store-hash', 'testhash', '--token', 'tok', '--channel', '12');
  assert.match(await run('env', 'list'), /storefront\s+store testhash, channel 12/);
  await run('create', '--all', '--env', 'storefront');
  fs.writeFileSync(path.join(ws, 'templates', 'channel-12', 'account_reset_password_email', 'subject.hbs'), 'Channel subject\n');
  out = await run('publish', 'account_reset_password_email', '--env', 'storefront', '--yes');
  assert.match(out, /Environment storefront: store testhash, channel 12/);
  assert.equal(puts.at(-1).query, '?channel_id=12');
  assert.equal(puts.at(-1).body.subject, 'Channel subject');

  // the store's own name and logo replace the sample store; the rest of the shared data is kept
  const globalFile = path.join(ws, 'fixtures', '_global.json');
  const shipped = JSON.parse(fs.readFileSync(globalFile));
  assert.equal(shipped.store.name, 'Example Store');
  fs.writeFileSync(globalFile, JSON.stringify({ ...shipped, store: { ...shipped.store, mine: 'kept' } }));
  out = await run('fixture', 'store');
  assert.match(out, /name {5}Mock Store\n {2}domain {3}mock\.example\n {2}logo {5}https:\/\/cdn99\.example\/s-testhash\/product_images\/logo\.png\?t=1\n {2}address {2}1 Mock St, Mockville/);
  assert.match(out, /Wrote theme-emails\/fixtures\/_global\.json\nEvery preview now shows the default environment's store/);
  const pulled = JSON.parse(fs.readFileSync(globalFile));
  assert.deepEqual(pulled.store, {
    ...shipped.store,
    name: 'Mock Store',
    domain_name: 'mock.example',
    cdn_path: 'https://cdn99.example/s-testhash', // taken from the logo's URL, which is where templates look for images
    logo: { title: 'Mock Store', name: 'logo.png', url: 'https://cdn99.example/s-testhash/product_images/logo.png?t=1' },
    ssl_path: 'https://mock.example',
    path_normal: 'https://mock.example',
    path: 'https://mock.example',
    address: '1 Mock St\nMockville',
    mine: 'kept',
  });
  assert.deepEqual(pulled.customer, shipped.customer, 'the customer stays sample data');
  // a store with no logo leaves the URL empty, so templates fall back to the store name
  await run('fixture', 'store', '--env', 'staging');
  const staged = JSON.parse(fs.readFileSync(globalFile)).store;
  assert.deepEqual(staged.logo, { title: 'Stage Store', name: '', url: '' });
  assert.equal(staged.cdn_path, 'https://cdn11.bigcommerce.com/s-stagehash', 'without a logo the CDN path comes from the store hash');
  fs.writeFileSync(globalFile, '{ not json');
  assert.match(await fails('fixture', 'store'), /fixtures\/_global\.json is not valid JSON/);
  fs.rmSync(globalFile);
  await run('fixture', 'store');
  assert.equal(JSON.parse(fs.readFileSync(globalFile)).customer.full_name, 'Jordan Rivera', 'a missing file starts from the shipped sample');
  // real catalog products by SKU, in an otherwise sample order
  assert.match(await fails('fixture', 'sku'), /No SKUs to look up\. Add a list to theme-emails\/email-builder\.json/);
  // the team's saved list is the normal source; numbers, blanks and repeats are tidied
  fs.writeFileSync(path.join(ws, 'email-builder.json'), JSON.stringify({ skus: ['T1', ' SHIRT-RED-M ', '', 'T1'] }));
  out = await run('fixture', 'sku');
  assert.match(out, /Looking up 2 SKU\(s\) from email-builder\.json/);
  assert.match(out, /T1 {2}Tote {2}£18\.50[\s\S]*SHIRT-RED-M {2}Shirt {2}£30\.00[\s\S]*Wrote theme-emails\/fixtures\/combined_order_status_email\/products\.json/);
  const fx = JSON.parse(fs.readFileSync(path.join(ws, 'fixtures', 'combined_order_status_email', 'products.json')));
  assert.deepEqual(fx.order.products[0], { name: 'Tote', sku: 'T1', price: '£18.50', quantity: 1, thumbnail: 'https://cdn.example/tote.jpg', brand: 'Acme', attribute_lines: [] });
  assert.deepEqual(fx.order.products[1].attribute_lines, [{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'M' }]);
  assert.equal(fx.order.products[1].thumbnail, 'https://cdn.example/shirt-red.jpg');
  assert.equal(fx.order.total.formatted, '£48.50');
  assert.equal(fx.order.customer_name, 'Jordan Rivera', 'the customer stays sample data');
  fs.writeFileSync(path.join(ws, 'email-builder.json'), JSON.stringify({ skus: ['T1', 'NOPE'] }));
  assert.match(await fails('fixture', 'sku', '--name', 'broken'), /No product or variant in this store's catalog has the SKU "NOPE"/);
  assert.ok(!fs.existsSync(path.join(ws, 'fixtures', 'combined_order_status_email', 'broken.json')), 'nothing is written when a SKU is missing');
  assert.match(await fails('fixture', 'order', '77'), /The fixture commands are "email-builder fixture sku" and "email-builder fixture store"/);
  fs.writeFileSync(path.join(ws, 'email-builder.json'), JSON.stringify({ skus: 'T1' }));
  assert.match(await fails('fixture', 'sku'), /"skus" in email-builder\.json must be a list/);
  // SKUs cannot be set on the command line
  assert.match(await fails('fixture', 'sku', 'T1'), /SKUs are not set on the command line/);
  r = await renderEmail(config, { typeId: 'combined_order_status_email', fixture: 'products' });
  assert.match(r.html, /Hi Jordan Rivera/);
  assert.match(r.html, /Tote x1 \(T1\)/);
  assert.match(r.html, /Mock Store/);
  // privacy: the tool never asks the store for orders or customers
  assert.ok(requests.length > 20);
  assert.deepEqual(requests.filter((path) => /orders|customers/.test(path)), []);
  assert.doesNotMatch(fs.readFileSync(path.join(ws, '.gitignore'), 'utf8'), /order-/);

  // lint: email client support from caniemail data, with positions that survive Handlebars
  const settingsFile = path.join(ws, 'email-builder.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ lint: { clients: ['outlook.windows'] } }));
  const resetBody = tpl('account_reset_password_email', 'body.html');
  fs.writeFileSync(resetBody, [
    '<html><head><style>',
    '.a { display: flex; }',
    '</style></head><body>',
    '{{#if x}}<p>{{lang "reset_password" name=store.name}}</p>{{/if}}',
    '<div style="display:grid">x</div>',
    '</body></html>',
  ].join('\n'));
  out = await fails('lint', 'account_reset_password_email');
  assert.match(out, /theme-emails\/templates\/global\/account_reset_password_email\/body\.html/);
  assert.match(out, /2:6\s+display:flex {2}not supported in outlook \(windows\)/);
  assert.match(out, /5:1\s+display:grid {2}not supported in outlook \(windows\)/);
  assert.match(out, /2 unsupported feature\(s\)\./);
  assert.match(await fails('lint', 'nope_email'), /No local template called nope_email/);
  // settings: ignore a feature you have decided to live with
  fs.writeFileSync(settingsFile, JSON.stringify({ lint: { clients: ['outlook.windows'], ignore: ['display:flex'] } }));
  out = await fails('lint', 'account_reset_password_email');
  assert.doesNotMatch(out, /display:flex/);
  assert.match(out, /1 unsupported feature/);
  // table-based markup passes, so lint can gate CI
  fs.writeFileSync(resetBody, '<html><body><table width="100%"><tr><td align="center" style="padding:10px;color:#333333">{{lang "reset_password" name=store.name}}</td></tr></table></body></html>');
  assert.match(await run('lint', 'account_reset_password_email'), /No problems found/);
  // caniemail has no word-wrap data for Gmail on iOS: that pair is skipped and the rest is still checked
  const lintSettings = fs.readFileSync(settingsFile, 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({ lint: { clients: ['gmail.ios', 'outlook.windows'] } }));
  fs.writeFileSync(resetBody, '<html><head><style>\n.a { word-wrap: break-word; }\n</style></head><body><div style="display:grid">x</div></body></html>');
  out = await fails('lint', 'account_reset_password_email');
  assert.doesNotMatch(out, /not found on/);
  assert.match(out, /2:6\s+word-wrap {2}not supported in outlook \(windows\)\n/);
  assert.match(out, /3:22\s+display:grid {2}not supported in outlook \(windows\)\n/);
  assert.match(out, /Checked 1 template\(s\) against 2 email client\(s\)[\s\S]*2 unsupported feature\(s\)\./);
  fs.writeFileSync(settingsFile, lintSettings);
  fs.writeFileSync(resetBody, '<div style="display:grid">x</div>');

  // preview server
  assert.match(await fails('start', 'nope_email'), /No local template called nope_email/);
  const { startServer } = await import('../dist/server.js');
  const server = await startServer({ ...config, port: 0 });
  const list = await (await fetch(`${server.url}/api/templates`)).json();
  assert.equal(list.templates.length, 2);
  assert.deepEqual(list.templates.find((t) => t.typeId === 'combined_order_status_email').fixtures, ['default', 'products']);
  const frame = await (await fetch(`${server.url}/frame?type=combined_order_status_email&fixture=products`)).text();
  assert.match(frame, /<head><base target="_blank">/);
  const meta = await (await fetch(`${server.url}/api/render?type=account_reset_password_email`)).json();
  assert.deepEqual(meta.compat, [{ line: 1, title: 'display:grid', clients: 'outlook (windows)' }]);
  assert.match((await (await fetch(`${server.url}/`)).text()), /Transactional emails/);
  // live reload fires on save
  const sse = await fetch(`${server.url}/events`);
  const reader = sse.body.getReader();
  await reader.read(); // retry preamble
  setTimeout(() => fs.appendFileSync(bodyFile, '<!-- edit -->'), 100);
  const chunk = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('no reload event')), 3000))]);
  assert.match(new TextDecoder().decode(chunk.value), /event: change/);
  await reader.cancel();
  server.close();

  // setup: one command on a fresh project chains credentials, environment, templates and preview data
  const runIn = async (dir, ...args) => {
    const child = exec('node', [cli, ...args], { cwd: dir, env, timeout: 20000 });
    child.child.stdin.end();
    return (await child).stdout;
  };
  fs.mkdirSync(path.join(fresh, 'theme-emails'), { recursive: true });
  fs.writeFileSync(path.join(fresh, 'theme-emails', 'email-builder.json'), JSON.stringify({ skus: ['T1'] })); // as if a teammate committed it
  out = await runIn(fresh, 'setup', 'staging', '--store-hash', 'stagehash', '--token', 'tok');
  assert.match(out, /Step 1 of 3[\s\S]*Connected[\s\S]*Step 2 of 3: templates, downloaded from staging \(store stagehash\)[\s\S]*Downloaded 2 template[\s\S]*Step 3 of 3[\s\S]*T1 {2}Tote[\s\S]*Setup complete\. Nothing is selected yet, so choose an environment before you start:\s+email-builder env use staging\s+email-builder start/);
  const freshWs = path.join(fresh, 'theme-emails');
  assert.ok(!fs.existsSync(path.join(freshWs, '.active-env')), 'setup does not select an environment');
  try {
    await runIn(fresh, 'start');
    assert.fail('start must refuse to run before an environment is chosen');
  } catch (e) {
    assert.match(String(e.stderr), /No environment selected\. Choose one first:\s+email-builder env use staging/);
  }
  assert.ok(fs.existsSync(path.join(freshWs, '.env.staging')));
  assert.ok(fs.existsSync(path.join(freshWs, 'templates', 'global', 'combined_order_status_email', 'body.html')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(freshWs, 'fixtures', '_global.json'))).store.name, 'Example Store');
  assert.ok(fs.existsSync(path.join(freshWs, 'fixtures', 'combined_order_status_email', 'products.json')));
  // rerunning is safe: no questions, local edits kept
  fs.appendFileSync(path.join(freshWs, 'templates', 'global', 'combined_order_status_email', 'body.html'), '<!-- mine -->');
  out = await runIn(fresh, 'setup', 'staging');
  assert.match(out, /staging: already saved[\s\S]*Kept your local edits to:\s+combined_order_status_email[\s\S]*Setup complete/);
  // several environments in one command
  await runIn(fresh, 'env', 'add', 'production', '--store-hash', 'testhash', '--token', 'tok');
  await runIn(fresh, 'env', 'use', 'production');
  out = await runIn(fresh, 'setup', 'staging', 'production');
  assert.match(out, /credentials for staging, production[\s\S]*staging: already saved[\s\S]*production: already saved[\s\S]*downloaded from staging[\s\S]*Setup complete\. production is the selected environment/);
  assert.equal(fs.readFileSync(path.join(freshWs, '.active-env'), 'utf8').trim(), 'production', 'a choice already made is left alone');
  try {
    await runIn(fresh, 'setup', 'staging', 'production', '--store-hash', 'x', '--token', 'y');
    assert.fail('one set of credentials cannot describe two environments');
  } catch (e) {
    assert.match(String(e.stderr), /describe one store/);
  }
  // bad credentials stop it before anything is downloaded
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'email-builder-bad-'));
  try {
    await runIn(bad, 'setup', '--store-hash', 'testhash', '--token', 'wrong');
    assert.fail('setup should fail with a bad token');
  } catch (e) {
    assert.match(String(e.stdout), /test request failed[\s\S]*Setup stopped and the default credentials were not kept/);
    assert.ok(!fs.existsSync(path.join(bad, 'theme-emails', '.env')));
    assert.ok(!fs.existsSync(path.join(bad, 'theme-emails', 'templates')));
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
  }

  console.log('All checks passed.');
} finally {
  api.close();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
}
