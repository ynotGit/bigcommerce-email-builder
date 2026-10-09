// End-to-end check of the built CLI against a mock of the BigCommerce API. Run with: npm test
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
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
    body: '<p>{{lang "reset_password" name=store.name}}</p><a href="{{reset_password.link}}">{{reset_password.link}}</a>',
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
for (const key of ['BC_STORE_HASH', 'BC_ACCESS_TOKEN', 'BC_CHANNEL_ID', 'EMAIL_BUILDER_ENV', 'FORCE_COLOR', 'NO_COLOR']) delete env[key];
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
  // the questions setup asks: other answers show as they are typed, the access token never reaches the screen
  const { prompter } = await import('../dist/init.js');
  const keyboard = new PassThrough();
  let screen = '';
  const terminal = prompter(keyboard, new Writable({ write(chunk, _encoding, done) { screen += chunk; done(); } }));
  let answer = terminal.ask('Store hash: ');
  keyboard.write('abc123\r');
  assert.equal(await answer, 'abc123');
  answer = terminal.askHidden('Access token (hidden): ');
  keyboard.write('SECRET-TOKEN\r');
  assert.equal(await answer, 'SECRET-TOKEN');
  answer = terminal.ask('Channel ID: ');
  keyboard.write('\x1b[A\r'); // the up arrow, which would bring the token back if answers were remembered
  assert.equal(await answer, '');
  terminal.close();
  screen = screen.replace(/\x1b\[\d*[A-Z]/g, ''); // without the cursor movements
  assert.equal(screen, 'Store hash: abc123\r\nAccess token (hidden): 12 characters entered\nChannel ID: \r\n');

  // create: lists what exists, downloads one by name or path, then all
  assert.match(await run('create'), /Name a template[\s\S]*order-status-update\n\s+password-reset/);
  assert.match(await fails('create', 'nope_email'), /no template called nope_email/);
  out = await run('create', 'theme-emails/templates/global/password-reset/');
  assert.match(out, /Downloaded 1 template.*into theme-emails\/templates\/global: 1 written/);
  assert.match(out, /Created theme-emails\/email-builder\.json with a starter "skus" list/);
  assert.ok(!fs.existsSync(tpl('order-status-update')));
  // folders are named as the BigCommerce admin lists the emails; commands also take the admin's spelling or the type ID
  assert.deepEqual(fs.readdirSync(tpl()), ['password-reset']);
  assert.deepEqual(fs.readdirSync(path.join(ws, 'fixtures')).sort(), ['_global.json', 'password-reset']);
  for (const name of ['Password Reset', 'account_reset_password_email']) {
    assert.match(await run('create', name), /Downloaded 1 template.*0 written, 1 already up to date/, name);
  }
  out = await run('create', '--all');
  assert.match(out, /Downloaded 2 template.*1 written, 1 already up to date/);
  assert.equal(fs.readFileSync(tpl('order-status-update', 'body.html'), 'utf8'), remote.combined_order_status_email.body);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(tpl('order-status-update', 'phrases.json')))), ['en', 'fr']);
  assert.ok(fs.existsSync(path.join(ws, 'fixtures', '_global.json')));
  // the first download also leaves a starter settings file with the usual preview SKUs
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, 'email-builder.json'))), { skus: ['SM13', 'DPB', 'OFSUC', 'OTL'] });
  assert.match(await run('status'), /Nothing to publish/);
  // the same commands work from inside theme-emails; the folder itself is not configurable
  assert.match((await exec('node', [cli, 'status'], { cwd: ws, env })).stdout, /Nothing to publish/);
  assert.match(await fails('status', '--dir', ws), /--dir is not an option\. Files always live in \.\/theme-emails/);
  assert.deepEqual(fs.readdirSync(cwd), ['theme-emails']);

  // local render
  const { loadConfig } = await import('../dist/config.js');
  const { listFixtures, renderEmail } = await import('../dist/render.js');
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
  fs.appendFileSync(tpl('password-reset', 'body.html'), '{{lang "nope"}}{{money 5}}{{lang "reset_password"}}{{missing.value}}');
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
    fs.writeFileSync(tpl('password-reset', 'body.html'), body);
    return renderEmail(config, { typeId: 'account_reset_password_email' });
  };
  r = await conditionals([
    "{{#if store.name '===' 'Example Store'}}same{{else}}differs{{/if}}",
    "{{#if misc.year '<' 2000}}old{{else}}new{{/if}}",
    "{{#or (if customer.first_name '===' 'Nope') (if misc.year '>' 2000)}}either{{else}}neither{{/or}}",
    "{{#or (if customer.first_name '===' 'Nope') missing}}either{{else}}neither{{/or}}",
    "{{#unless customer.first_name '===' 'Jordan'}}stranger{{else}}known{{/unless}}",
    "{{#if reset_password}}reset{{/if}}{{#if missing}}never{{/if}}{{#unless missing}}absent{{/unless}}",
    "{{#if 0}}zero{{else}}no zero{{/if}}",
    "{{#if store.name 'Example Store' operator='!='}}renamed{{else}}as shipped{{/if}}",
    "{{#for 1 3}}[{{$index}}]{{/for}}{{#for 2}}({{$index}}){{/for}}{{#for 1 2 customer}}<{{first_name}}{{$index}}>{{/for}}",
  ].join('|'));
  assert.equal(r.error, null);
  assert.equal(r.html, 'same|new|either|neither|known|resetabsent|no zero|as shipped|[1][2][3](1)(2)<Jordan1><Jordan2>');
  assert.deepEqual(r.warnings, []);
  assert.equal((await conditionals('{{#for 1 500}}.{{/for}}')).html.length, 100, 'a loop stops at 100 rounds, as it does at BigCommerce');
  assert.match((await conditionals("{{#if 1 'nope' 2}}x{{/if}}")).error, /does not know the operator "nope"/);

  // the older helpers BigCommerce's stock order email still uses: compare and replace (eachIndex is checked with the lists below)
  r = await conditionals([
    "{{#compare misc.year 2000 operator='>'}}later{{else}}earlier{{/compare}}",
    "{{#compare store.name 'Example Store'}}same{{/compare}}",
    "{{#compare customer 'array' operator='typeof'}}list{{else}}not a list{{/compare}}",
    "{{#replace '%%DATE%%' 'Ships %%DATE%%, %%DATE%%'}}{{misc.year}}{{else}}no date{{/replace}}",
    "{{#replace '%%DATE%%' store.name}}{{misc.year}}{{else}}{{store.name}}{{/replace}}",
  ].join('|'));
  assert.equal(r.error, null);
  assert.equal(r.html, 'later|same|not a list|Ships 2026, 2026|Example Store');
  assert.deepEqual(r.warnings, []);
  assert.match((await conditionals("{{#compare '2' '1' operator='gtnum'}}x{{/compare}}")).error, /compare helper does not know the operator "gtnum"/);
  assert.match((await conditionals('{{#compare 1}}x{{/compare}}')).error, /compare helper needs two values/);

  // join: a list glued with a separator, with limit and lastSeparator; an HTML separator needs triple braces
  const listsFile = path.join(ws, 'fixtures', 'password-reset', 'lists.json');
  fs.writeFileSync(listsFile, JSON.stringify({ lines: ['1 Main St', 'Austin', 'TX'], name: 'not a list' }));
  fs.writeFileSync(tpl('password-reset', 'body.html'), "{{join lines ', '}}|{{{join lines '<br>'}}}|{{join lines '<br>'}}|{{join lines ', ' limit=2}}|{{join lines ', ' lastSeparator=' and '}}|[{{join missing ', '}}]|{{#eachIndex lines}}{{index}}={{item}} {{/eachIndex}}[{{#eachIndex missing}}never{{/eachIndex}}]");
  r = await renderEmail(config, { typeId: 'account_reset_password_email', fixture: 'lists' });
  assert.equal(r.error, null);
  assert.equal(r.html, '1 Main St, Austin, TX|1 Main St<br>Austin<br>TX|1 Main St&lt;br&gt;Austin&lt;br&gt;TX|1 Main St, Austin|1 Main St, Austin and TX|[]|0=1 Main St 1=Austin 2=TX []');
  assert.deepEqual(r.warnings, [], 'a list missing from the preview data renders empty, like any missing variable');
  fs.writeFileSync(tpl('password-reset', 'body.html'), "[{{join name ', '}}]");
  r = await renderEmail(config, { typeId: 'account_reset_password_email', fixture: 'lists' });
  assert.equal(r.html, '[]');
  assert.match(r.warnings.join(' | '), /join helper was given something that is not a list/);
  fs.rmSync(listsFile);

  // create keeps local edits unless forced
  out = await run('create', '--all');
  assert.match(out, /Kept your local edits to:\s+password-reset/);
  await run('create', '--all', '--force');
  assert.equal(fs.readFileSync(tpl('password-reset', 'body.html'), 'utf8'), remote.account_reset_password_email.body);

  // publish: guards, dry run, real publish
  const subjectFile = tpl('password-reset', 'subject.hbs');
  fs.writeFileSync(subjectFile, 'New subject for {{store.name}}\n');
  assert.match(await run('status'), /password-reset\s+changed: subject/);
  assert.match(await run('publish', '--all', '--dry-run'), /Dry run/);
  assert.match(await fails('publish', '--all'), /Not publishing without confirmation/);
  // an option a command does not take stops it before anything runs: a misspelt --dry-run must never become a real publish
  assert.match(await fails('publish', '--all', '--dryrun', '--yes'), /Unknown option --dryrun\. "publish" takes --all, --dry-run, --yes and --env\. Nothing was run\./);
  assert.match(await fails('publish', '--all', '-n', '--yes'), /Unknown option -n\. "publish" takes/);
  assert.match(await fails('publish', '--all', '--yes=false'), /--yes does not take a value\./);
  assert.match(await fails('status', '--all', '--force'), /Unknown options --all, --force\. "status" takes --env\. Nothing was run\./);
  assert.equal(puts.length, 0);

  const bodyFile = tpl('order-status-update', 'body.html');
  const goodBody = fs.readFileSync(bodyFile, 'utf8');
  fs.writeFileSync(bodyFile, '{{#if order}}unclosed');
  assert.match(await fails('publish', '--all', '--yes'), /blocked\s+order-status-update: Handlebars syntax error/);
  fs.writeFileSync(bodyFile, 'x'.repeat(65537));
  assert.match(await fails('publish', '--all', '--yes'), /truncates past 65,536/);
  assert.equal(puts.length, 0, 'a blocked template must stop the whole publish');
  fs.writeFileSync(bodyFile, goodBody);

  out = await run('publish', '--all', '--yes');
  assert.match(out, /published\s+password-reset/);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/v3/marketing/email-templates/account_reset_password_email');
  assert.equal(puts[0].body.subject, 'New subject for {{store.name}}');
  assert.deepEqual(puts[0].body.translations, [{ locale: 'en', keys: { reset_password: 'To change your password at {name} click:' } }]);
  assert.match(await run('status'), /Nothing to publish/);

  // colour: green for what worked, orange for a warning, red for an error. Only a terminal gets it, so
  // everything above ran plain; FORCE_COLOR stands in for a terminal here and NO_COLOR turns it off again
  const coloured = async (extra, ...args) => {
    const child = exec('node', [cli, ...args], { cwd, env: { ...env, FORCE_COLOR: '1', ...extra } });
    child.child.stdin.end();
    return child.then((done) => done.stdout, (e) => `${e.stdout}${e.stderr}`);
  };
  const [green, orange, red, reset] = ['\x1b[32m', '\x1b[38;5;208m', '\x1b[31m', '\x1b[39m'];
  assert.ok((await coloured({}, 'status')).includes(`${green}Nothing to publish. Local templates match the global templates.${reset}`));
  assert.ok((await coloured({}, 'publish')).includes(`${red}Name the templates to publish, or pass --all for every changed one.${reset}`));
  fs.writeFileSync(subjectFile, 'Edited locally\n');
  out = await coloured({}, 'create', '--all');
  assert.ok(out.includes(`${orange}Kept your local edits to:\n  password-reset${reset}\nAdd --force`), out);
  assert.ok(out.includes(`${green}Downloaded 2 template(s)`));
  assert.doesNotMatch(await coloured({ FORCE_COLOR: '', NO_COLOR: '1' }, 'create', '--all'), /\x1b\[/);
  await run('create', '--all', '--force');

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
  fs.writeFileSync(path.join(ws, 'templates', 'channel-12', 'password-reset', 'subject.hbs'), 'Channel subject\n');
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
  fs.writeFileSync(path.join(ws, 'email-builder.json'), '{}'); // as if the team had cleared the starter list
  assert.match(await fails('fixture', 'sku'), /No SKUs to look up\. Add a list to theme-emails\/email-builder\.json/);
  // the team's saved list is the normal source; numbers, blanks and repeats are tidied
  fs.writeFileSync(path.join(ws, 'email-builder.json'), JSON.stringify({ skus: ['T1', ' SHIRT-RED-M ', '', 'T1'] }));
  out = await run('fixture', 'sku');
  assert.match(out, /Looking up 2 SKU\(s\) from email-builder\.json/);
  assert.match(out, /T1 {2}Tote {2}£18\.50[\s\S]*SHIRT-RED-M {2}Shirt {2}£30\.00[\s\S]*Wrote theme-emails\/fixtures\/_products\.json\nChoose "products" under Preview data on any email to see them/);
  // one shared file holds only the products, in each place an email reads them from
  const fx = JSON.parse(fs.readFileSync(path.join(ws, 'fixtures', '_products.json')));
  assert.deepEqual(Object.keys(fx), ['order', 'review', 'return', '@order-email']);
  assert.deepEqual(fx.review.products.map((p) => [p.sku, p.link]), [['T1', '#review'], ['SHIRT-RED-M', '#review']]);
  assert.deepEqual(fx.return.products, fx.order.products);
  assert.equal(fx.return.product.sku, 'T1');
  assert.deepEqual(fx.order.products[0], { name: 'Tote', sku: 'T1', price: '£18.50', quantity: 1, thumbnail: 'https://cdn.example/tote.jpg', brand: 'Acme', attribute_lines: [] });
  assert.deepEqual(fx.order.products[1].attribute_lines, [{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'M' }]);
  assert.equal(fx.order.products[1].thumbnail, 'https://cdn.example/shirt-red.jpg');
  assert.equal(fx.order.total.formatted, '£48.50');
  // the order email reads prices as objects, attributes as text and the totals as rows, so it gets a part of its own
  const invoice = fx['@order-email'].order;
  assert.deepEqual(invoice.products[1], {
    name: 'Shirt', sku: 'SHIRT-RED-M', type: 'physical', brand: '', thumbnail: 'https://cdn.example/shirt-red.jpg', quantity: 1,
    price: { value: 30, formatted: '£30.00' }, total: { value: 30, formatted: '£30.00' }, options: [],
    attribute_lines: ['Color: Red', 'Size: M'], configurable_fields: [],
  });
  assert.deepEqual(invoice.products[0].address_lines, ['Jordan Rivera', '12 Sample Street', 'Austin, Texas 78701', 'United States'], 'the sample shipping address is kept');
  assert.deepEqual(invoice.total_rows.map((row) => [row.label, row.price.formatted]), [['Subtotal', '£48.50'], ['Shipping', '£0.00'], ['Grand total', '£48.50']]);
  // only the email named after the @ gets that part, and no @ key reaches a template
  const onlyFile = path.join(ws, 'fixtures', '_only.json');
  fs.writeFileSync(onlyFile, JSON.stringify({ note: 'all', '@password-reset': { note: 'mine' }, '@order-status-update': { note: 'theirs' } }));
  fs.writeFileSync(tpl('password-reset', 'body.html'), '{{note}}{{#each this}}{{#if @key \'===\' \'@password-reset\'}}leaked{{/if}}{{/each}}');
  assert.equal((await renderEmail(config, { typeId: 'account_reset_password_email', fixture: 'only' })).html, 'mine');
  fs.rmSync(onlyFile);
  // every email offers it, and it is laid over that email's own default data
  assert.deepEqual(listFixtures(config, 'account_reset_password_email'), ['default', 'products']);
  fs.writeFileSync(tpl('password-reset', 'body.html'), '{{#each order.products}}{{sku}} {{/each}}{{#each review.products}}{{link}} {{/each}}{{return.product.name}} {{reset_password.link}}');
  r = await renderEmail(config, { typeId: 'account_reset_password_email', fixture: 'products' });
  assert.equal(r.html, 'T1 SHIRT-RED-M #review #review Tote https://example-store.mybigcommerce.com/login.php?action&#x3D;change_password&amp;c&#x3D;1&amp;t&#x3D;sample-token');
  // --template writes one email's own file instead, starting from its sample data
  out = await run('fixture', 'sku', '--template', 'account_reset_password_email', '--name', 'mine');
  assert.match(out, /Wrote theme-emails\/fixtures\/password-reset\/mine\.json\nChoose "mine" under Preview data on password-reset/);
  const mine = JSON.parse(fs.readFileSync(path.join(ws, 'fixtures', 'password-reset', 'mine.json')));
  assert.equal(mine.order.products.length, 2);
  assert.match(mine.reset_password.link, /sample-token/);
  // an email with a file of the same name keeps using its own, and the command says so
  out = await run('fixture', 'sku', '--name', 'mine');
  assert.match(out, /These emails have a mine\.json of their own and keep using it\. Delete it to use the shared one:\n {2}password-reset\n/);
  fs.rmSync(path.join(ws, 'fixtures', '_mine.json'));
  fs.rmSync(path.join(ws, 'fixtures', 'password-reset', 'mine.json'));
  fs.writeFileSync(path.join(ws, 'email-builder.json'), JSON.stringify({ skus: ['T1', 'NOPE'] }));
  assert.match(await fails('fixture', 'sku', '--name', 'broken'), /No product or variant in this store's catalog has the SKU "NOPE"/);
  assert.ok(!fs.existsSync(path.join(ws, 'fixtures', '_broken.json')), 'nothing is written when a SKU is missing');
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
  const resetBody = tpl('password-reset', 'body.html');
  fs.writeFileSync(resetBody, [
    '<html><head><style>',
    '.a { display: flex; }',
    '</style></head><body>',
    '{{#if x}}<p>{{lang "reset_password" name=store.name}}</p>{{/if}}',
    '<div style="display:grid">x</div>',
    '</body></html>',
  ].join('\n'));
  out = await fails('lint', 'account_reset_password_email');
  assert.match(out, /theme-emails\/templates\/global\/password-reset\/body\.html/);
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
  assert.match(await run('lint', 'password-reset'), /No problems found/);
  // caniemail has no word-wrap data for Gmail on iOS: that pair is skipped and the rest is still checked
  const lintSettings = fs.readFileSync(settingsFile, 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({ lint: { clients: ['gmail.ios', 'outlook.windows'] } }));
  fs.writeFileSync(resetBody, '<html><head><style>\n.a { word-wrap: break-word; }\n</style></head><body><div style="display:grid">x</div></body></html>');
  out = await fails('lint', 'account_reset_password_email');
  assert.doesNotMatch(out, /not found on/);
  assert.match(out, /2:6\s+word-wrap {2}not supported in outlook \(windows\)\n/);
  assert.match(out, /3:22\s+display:grid {2}not supported in outlook \(windows\)\n/);
  assert.match(out, /Checked 1 template\(s\) against 2 email client\(s\)[\s\S]*2 unsupported feature\(s\)\./);
  // lint --accept: what the templates use today goes on the ignore list, once, so later runs report only what is new
  fs.writeFileSync(settingsFile, '{\n  "skus": ["T1", "SHIRT-RED-M"],\n  "lint": { "clients": ["outlook.windows"] }\n}\n');
  fs.writeFileSync(resetBody, '<html><head><style>\n.a { display: flex; border-radius: 4px; }\n</style></head><body><div style="display:grid">x</div></body></html>');
  out = await run('lint', '--accept');
  assert.match(out, /Checked 2 template\(s\)\. Accepted 3 feature\(s\) they already use:\n {2}border-radius\n {2}display:flex\n {2}display:grid\n\nWrote theme-emails\/email-builder\.json\n/);
  // the rest of the file is kept, including the built-in exception that an explicit list would otherwise drop
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), [
    '{',
    '  "skus": ["T1", "SHIRT-RED-M"],',
    '  "lint": {',
    '    "clients": ["outlook.windows"],',
    '    "ignore": ["<body> element", "border-radius", "display:flex", "display:grid"]',
    '  }',
    '}',
    '',
  ].join('\n'));
  assert.match(await run('lint'), /No problems found/);
  assert.match(await run('lint', '--accept'), /Nothing to accept: no problems are being reported\./);
  // something added afterwards is still reported, and only that
  fs.appendFileSync(resetBody, '<p style="opacity:0.5;display:flex">y</p>');
  out = await fails('lint');
  assert.match(out, /opacity {2}not supported in outlook \(windows\)/);
  assert.match(out, /\n1 unsupported feature\(s\)\./);
  // a list too long for one line goes one feature to a line, so one is easy to delete
  fs.writeFileSync(resetBody, '<html><head><style>\n.a { box-sizing: border-box; visibility: hidden; }\n</style></head><body><p style="opacity:0.5">y</p></body></html>');
  out = await run('lint', '--accept', 'password-reset');
  assert.match(out, /Checked 1 template\(s\)\. Accepted 3 feature\(s\) they already use:\n {2}box-sizing\n {2}opacity\n {2}visibility\n/);
  assert.match(fs.readFileSync(settingsFile, 'utf8'), /"skus": \["T1", "SHIRT-RED-M"\],[\s\S]*"ignore": \[\n {6}"<body> element",\n {6}"border-radius",\n {6}"display:flex",\n {6}"display:grid",\n {6}"box-sizing",\n {6}"opacity",\n {6}"visibility"\n {4}\]/);
  fs.writeFileSync(settingsFile, lintSettings);
  fs.writeFileSync(resetBody, '<div style="display:grid">x</div>');

  // preview server
  assert.match(await fails('start', 'nope_email'), /No local template called nope_email/);
  const { startServer } = await import('../dist/server.js');
  const server = await startServer({ ...config, port: 0 });
  const list = await (await fetch(`${server.url}/api/templates`)).json();
  assert.equal(list.templates.length, 2);
  assert.deepEqual(list.templates.find((t) => t.typeId === 'combined_order_status_email').fixtures, ['default', 'products']);
  assert.deepEqual(list.templates.map((t) => [t.name, t.folder]), [['Order Status Update', 'order-status-update'], ['Password Reset', 'password-reset']]);
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
  assert.match(out, /Step 1 of 4[\s\S]*Connected[\s\S]*Step 2 of 4: templates, downloaded from staging \(store stagehash\)[\s\S]*Downloaded 2 template[\s\S]*Step 3 of 4: the store's name and logo for the preview, from staging\n {2}name {5}Stage Store[\s\S]*Step 4 of 4[\s\S]*T1 {2}Tote[\s\S]*Setup complete\. Nothing is selected yet, so choose an environment before you start:\s+email-builder env use staging\s+email-builder start/);
  const freshWs = path.join(fresh, 'theme-emails');
  assert.ok(!fs.existsSync(path.join(freshWs, '.active-env')), 'setup does not select an environment');
  try {
    await runIn(fresh, 'start');
    assert.fail('start must refuse to run before an environment is chosen');
  } catch (e) {
    assert.match(String(e.stderr), /No environment selected\. Choose one first:\s+email-builder env use staging/);
  }
  assert.ok(fs.existsSync(path.join(freshWs, '.env.staging')));
  assert.ok(fs.existsSync(path.join(freshWs, 'templates', 'global', 'order-status-update', 'body.html')));
  // the preview starts with the real store's details, so its logo and icons are not broken images
  const freshStore = JSON.parse(fs.readFileSync(path.join(freshWs, 'fixtures', '_global.json'))).store;
  assert.deepEqual([freshStore.name, freshStore.cdn_path], ['Stage Store', 'https://cdn11.bigcommerce.com/s-stagehash']);
  assert.ok(fs.existsSync(path.join(freshWs, 'fixtures', '_products.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(freshWs, 'email-builder.json'))), { skus: ['T1'] }, 'a settings file that is already there is never replaced');
  // rerunning is safe: no questions, local edits kept
  fs.appendFileSync(path.join(freshWs, 'templates', 'global', 'order-status-update', 'body.html'), '<!-- mine -->');
  out = await runIn(fresh, 'setup', 'staging');
  assert.match(out, /staging: already saved[\s\S]*Kept your local edits to:\s+order-status-update[\s\S]*Setup complete/);
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
  // a project from before folders and the phrases file took the admin's names is renamed in place by the next command
  for (const parent of [path.join(freshWs, 'templates', 'global'), path.join(freshWs, 'fixtures')]) {
    fs.renameSync(path.join(parent, 'order-status-update'), path.join(parent, 'combined_order_status_email'));
  }
  const freshTpl = (...parts) => path.join(freshWs, 'templates', 'global', ...parts);
  for (const email of ['combined_order_status_email', 'password-reset']) fs.renameSync(freshTpl(email, 'phrases.json'), freshTpl(email, 'translations.json'));
  out = await runIn(fresh, 'status');
  assert.match(out, /Renamed 4 file\(s\) or folder\(s\) to match the names in the BigCommerce admin, for example theme-emails\/templates\/global\/order-status-update\n/);
  assert.match(out, /order-status-update {2}changed: body\n/, 'the phrases still match the store, so the renamed file is the one being read');
  assert.deepEqual(fs.readdirSync(path.join(freshWs, 'templates', 'global')), ['order-status-update', 'password-reset']);
  for (const email of ['order-status-update', 'password-reset']) assert.deepEqual(fs.readdirSync(freshTpl(email)).sort(), ['body.html', 'phrases.json', 'subject.hbs']);
  assert.ok(fs.existsSync(path.join(freshWs, 'fixtures', 'order-status-update', 'default.json')));
  assert.doesNotMatch(await runIn(fresh, 'status'), /Renamed/);
  // every email that reads data of its own ships with sample data, filed under a type ID the tool knows
  const { folderName } = await import('../dist/names.js');
  const { ensureDefaultFixtures } = await import('../dist/fixtures.js');
  const samples = fs.readdirSync(path.join(path.dirname(cli), '..', 'defaults')).filter((f) => !['_global.json', 'email-builder.json'].includes(f)).map((f) => f.slice(0, -5));
  assert.equal(samples.length, 14);
  for (const typeId of samples) assert.notEqual(folderName(typeId), typeId, `${typeId} is not an email this tool knows`);
  // a project from before an email had sample data holds an empty placeholder, which is filled in; edited data is kept
  const freshConfig = { ...config, root: freshWs, fixturesDir: path.join(freshWs, 'fixtures') };
  const placeholder = path.join(freshWs, 'fixtures', 'password-reset', 'default.json');
  fs.writeFileSync(placeholder, '{}\n');
  fs.writeFileSync(path.join(freshWs, 'fixtures', 'order-status-update', 'default.json'), '{ "order": { "id": 7 } }');
  assert.deepEqual(ensureDefaultFixtures(freshConfig, ['account_reset_password_email', 'combined_order_status_email', 'createaccount_email']), ['fixtures/password-reset/default.json', 'fixtures/account-created/default.json']);
  assert.match(JSON.parse(fs.readFileSync(placeholder, 'utf8')).reset_password.link, /sample-token/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(freshWs, 'fixtures', 'order-status-update', 'default.json'), 'utf8')).order.id, 7);
  assert.deepEqual(ensureDefaultFixtures(freshConfig, ['account_reset_password_email', 'createaccount_email']), [], 'an email with no sample data keeps its empty file');
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
