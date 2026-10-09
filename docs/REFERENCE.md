# Reference

The [README](../README.md) covers the everyday flow. This page has the detail.

- [Commands](#commands)
- [Environments](#environments)
- [Make targets](#make-targets)
- [Files](#files)
- [Email names](#email-names)
- [Settings file](#settings-file)
- [Preview data](#preview-data)
- [How the preview differs from a real email](#how-the-preview-differs-from-a-real-email)
- [Email client check](#email-client-check)
- [Safety](#safety)
- [Working on the tool](#working-on-the-tool)

## Commands

| Command | What it does |
| --- | --- |
| `setup [environment...]` | Saves credentials for each environment named (`default` if none), downloads every template from the first one, and runs `fixture sku` for the `skus` list. Does not select an environment. Safe to rerun: it skips saved credentials and keeps local edits. Stops before downloading if the credentials fail. |
| `env` | Lists saved environments; `*` marks the selected one. |
| `env use <name>` | Points every command at that environment until you switch again. |
| `env add <name>` | Saves one more store's credentials. `--force` replaces existing ones. |
| `start [template]` | Preview server with live reload. `--port` changes the port. |
| `publish <template...>` | Uploads the named templates; `--all` takes every changed one. Shows the plan and asks first. `--dry-run` stops after the plan; `--yes` skips the question. |
| `status` | Lists templates that differ from the store. |
| `lint [template...]` | Flags unsupported HTML and CSS. Exits non-zero if it finds any, so CI can use it. `--partial` also lists features that only partly work. |
| `create <template>` | Downloads one template. `--all` downloads every one. With no name it lists what the store has. Keeps local edits unless you pass `--force`. Adds a starter `email-builder.json` if the project has none. |
| `fixture sku` | Builds preview data with the products in the `skus` list, for every email to use. `--template` writes it for one email only; `--name` sets the file name. |
| `fixture store` | Puts the store's own name, logo, domain, address and CDN path into the preview data every email shares. Images in the stock templates need it. |
| `init` | Sets up a single environment called `default`. `setup` does this and more. |

A template is named by its folder (`order-status-update`). A path to the
folder, the admin name in quotes (`"Order Status Update"`) and the API type
ID (`combined_order_status_email`) work too. See [Email names](#email-names).

Add `--env <name>` to any command to use that environment for that command
only.

Commands work from the project root or from inside `theme-emails/`. The folder
name is fixed.

For scripts, `setup`, `env add` and `init` accept
`--store-hash <hash> --token <token> [--channel <id>]` instead of asking.
The store hash can be the full API path BigCommerce shows.

## Environments

An environment is one store: a store hash, an API token and, optionally, a
channel ID.

- With named environments saved, commands refuse to run until you choose one
  with `env use` or `--env`. The exception is a project whose only environment
  is `default`, where there is nothing to choose between.
- Templates on disk are shared across environments. The usual flow is: edit,
  publish to staging, check a test email, then publish to production.
- `default` is stored in `theme-emails/.env`, others in `.env.<name>`, and the
  selection in `.active-env`. All are gitignored, so each developer has their
  own.
- When an environment has a saved file, its store, token and channel come only
  from that file. Shell variables such as `BC_STORE_HASH` are used only when
  no file exists (useful in CI).
- The channel ID is set when you save an environment (leave it blank for the
  store's global templates) and cannot be overridden per command. An
  environment with a channel ID uses `templates/channel-<id>/`, so two
  environments with different channel IDs do not share template files.

## Make targets

Add to your Makefile (the indented lines start with a tab):

    set-email-environment-%:
    	npx email-builder env use $*

    setup-emails-%:
    	npx email-builder setup $*

`make set-email-environment-staging` then switches to staging. Drop `npx` if
the tool is installed globally.

## Files

    theme-emails/
      .env, .env.<name>, .active-env                 credentials and selection (gitignored)
      email-builder.json                             team settings; a starter is added with the templates
      templates/global/<email>/body.html             the email body (Handlebars)
      templates/global/<email>/subject.hbs           the subject line
      templates/global/<email>/phrases.json          phrases, keyed by locale
      fixtures/_global.json                          preview data shared by every email
      fixtures/<email>/default.json                  preview data for one email
      fixtures/_products.json                        written by `fixture sku`, offered for every email

## Email names

The API knows each email by a type ID, and does not return the name the admin
shows under Marketing > Transactional Emails. The tool keeps that list itself
and names folders after the admin name. The preview lists emails by the admin
name too.

| In the admin | Folder | API type ID |
| --- | --- | --- |
| Abandoned Cart | `abandoned-cart` | `abandoned_cart_email` |
| Account Created | `account-created` | `createaccount_email` |
| Account Settings Edited | `account-settings-edited` | `account_details_changed_email` |
| Gift Certificate Recipient | `gift-certificate-recipient` | `giftcertificate_email` |
| Guest Account Created | `guest-account-created` | `createguestaccount_email` |
| Guest Order Access | `guest-order-access` | `guest_order_access_email` |
| Order Email | `order-email` | `invoice_email` |
| Order Notification | `order-notification` | `ordermessage_notification` |
| Order ready for pickup | `order-ready-for-pickup` | `order_ready_for_pickup` |
| Order Status Update | `order-status-update` | `combined_order_status_email` |
| Password Reset | `password-reset` | `account_reset_password_email` |
| Product Review Request | `product-review-request` | `product_review_email` |
| Return Requested | `return-requested` | `return_confirmation_email` |
| Return Status Change | `return-status-change` | `return_statuschange_email` |
| Sign-in Link Request | `sign-in-link-request` | `passwordless_login_email` |

An email BigCommerce adds later keeps its type ID as its folder name until
this list catches up. A project whose folders are still named by type ID is
renamed in place the next time you run a command.

## Settings file

`theme-emails/email-builder.json` is committed with the project. If there is
none, `create` and `setup` add a starter whose `skus` list is SM13, DPB, OFSUC
and OTL. An existing file is never replaced.

    {
      "skus": ["TOTE-NAT", "MUG-BLU", "SHIRT-RED-M"],
      "lint": {
        "clients": ["gmail.*", "outlook.*", "apple-mail.*"],
        "ignore": ["<body> element", "border-radius"]
      }
    }

- `skus`: products for `fixture sku`. A SKU can be a product's or a variant's.
- `lint.clients`: caniemail client names (`outlook.windows`, `gmail.ios`) or
  globs. Default: Gmail, Outlook, Apple Mail, Yahoo and Samsung Email.
- `lint.ignore`: feature titles, exactly as `lint` prints them, to stop
  reporting. Default: `["<body> element"]`. Setting it replaces the default.

## Preview data

Each fixture is merged over `_global.json`, and the result is the object the
template renders against. A fixture whose file sits beside `_global.json`
with a leading underscore, such as `_products.json`, is shared: every email
offers it, and it is merged over that email's `default.json`. The shape for each email is in BigCommerce's
[email object reference](https://docs.bigcommerce.com/developer/docs/admin/store-configuration/emails/email-object-reference/global-email-object).

Every email starts with sample data in its `default.json`: a made-up
customer, order, billing address, payment and so on, covering what the stock
template reads. Edit it freely. A `default.json` that an older version of the
tool left empty (`{}`) is filled in the next time you run `start`.

Emails do not all read the same data in the same shape. The order email, for
one, wants a product's price as an object where the others want text. So a
shared fixture can hold a part for one email alone, under `@` and that
email's folder name: `"@order-email": { "order": { ... } }` is merged last,
and only for the order email.

Two commands add real, non-personal data:

- `fixture sku` looks up each SKU in the selected environment's catalog and
  writes `fixtures/_products.json`, one line item per SKU, quantity 1, total
  the sum of the prices. Choose "products" under Preview data on any email:
  the products show wherever that email lists them (an order, a review
  request or a return), and an email with no product list looks the same as
  with "default". The order email also gets its totals rows recalculated. An
  email that has a `products.json` of its own keeps using that one;
  `fixture sku --template <email>` writes such a file.
- `fixture store` reads the selected environment's store profile and writes
  its name, logo, domain, address and CDN path into `_global.json`. The sample
  customer and anything you added by hand stay. BigCommerce's stock templates
  build the logo and icon URLs from `store.cdn_path`, so those images are
  broken in the preview until you run this. A store with no logo gets an empty
  logo URL, so templates fall back to the store name as they do in a real
  email.
  `_global.json` is shared by every environment, so it shows the store you
  last ran this against.

The preview never contacts the store. It reads these files, so rerun
`fixture sku` when the list, prices or images change, and `fixture store`
when the logo or store details do.

## How the preview differs from a real email

BigCommerce has no API that renders a template, so the preview is a local
Handlebars render.

- `{{lang 'key' name=value}}` works: it reads `phrases.json` for the
  selected language and fills `{name}` placeholders.
- The Handlebars built-ins (`if`, `unless`, `each`, `with`) work.
- BigCommerce's own conditionals and loop work: `if` and `unless` with a
  comparison (`{{#if order.new_status '===' 'Shipped'}}`), `or`, `for`, and
  `(if ...)` nested inside another helper. They follow BigCommerce's
  open-source Stencil helpers, so an empty object counts as false.
- `join` works, with `limit` and `lastSeparator`. A list that is missing from
  the preview data renders empty.
- `compare`, `replace` and `eachIndex` work; the stock order email uses them
  in its product rows.
- Any other BigCommerce helper is not available. The preview highlights where
  it is used and lists a warning; check that part with a test email.

## Email client check

`lint` uses the support data from [caniemail.com](https://www.caniemail.com),
bundled in the `caniemail` npm package, and reports the line and column in
`body.html`:

    theme-emails/templates/global/order-status-update/body.html
      4:13     display:flex  not supported in outlook (windows)

The same results show under the preview, and `publish` mentions them without
blocking. Run `npm update caniemail` in the tool's folder for newer data.

Limits: Handlebars tags are hidden from the checker, so markup that only
exists after rendering (for example HTML inside a phrase) is not checked.
caniemail.com has no data for some feature and client pairs (for example
`word-wrap` in Gmail on iOS); those are skipped, not reported.

## Safety

- `publish` refuses a template with a Handlebars syntax error or a body over
  65,536 characters (BigCommerce truncates past that), and publishes nothing
  if any template in the batch is blocked.
- The tool never requests orders or customers.
- The preview only listens on localhost.

## Working on the tool

    npm install         # also compiles the TypeScript
    npm link            # puts `email-builder` on your PATH
    npm run typecheck
    npm test            # build, then run the whole flow against a mock API

Source is TypeScript in `src/`: `cli.ts` (commands), `config.ts`
(environments), `render.ts` (preview), `lint.ts` (email client check),
`fixtures.ts` (preview data), `types.ts` (API and email object shapes). The
preview page is `assets/ui.html`.

The test covers every command against a mock of the BigCommerce API. The tool
has not yet been run against a live store.
