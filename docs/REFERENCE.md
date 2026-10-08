# Reference

The [README](../README.md) covers the everyday flow. This page has the detail.

- [Commands](#commands)
- [Environments](#environments)
- [Make targets](#make-targets)
- [Files](#files)
- [Settings file](#settings-file)
- [Preview data](#preview-data)
- [How the preview differs from a real email](#how-the-preview-differs-from-a-real-email)
- [Email client check](#email-client-check)
- [Safety](#safety)
- [Working on the tool](#working-on-the-tool)

## Commands

| Command | What it does |
| --- | --- |
| `setup [environment...]` | Saves credentials for each environment named (`default` if none), downloads every template from the first one, and runs `fixture sku` if a `skus` list exists. Does not select an environment. Safe to rerun: it skips saved credentials and keeps local edits. Stops before downloading if the credentials fail. |
| `env` | Lists saved environments; `*` marks the selected one. |
| `env use <name>` | Points every command at that environment until you switch again. |
| `env add <name>` | Saves one more store's credentials. `--force` replaces existing ones. |
| `start [template]` | Preview server with live reload. `--port` changes the port. |
| `publish <template...>` | Uploads the named templates; `--all` takes every changed one. Shows the plan and asks first. `--dry-run` stops after the plan; `--yes` skips the question. |
| `status` | Lists templates that differ from the store. |
| `lint [template...]` | Flags unsupported HTML and CSS. Exits non-zero if it finds any, so CI can use it. `--partial` also lists features that only partly work. |
| `create <template>` | Downloads one template. `--all` downloads every one. With no name it lists what the store has. Keeps local edits unless you pass `--force`. |
| `fixture sku` | Builds preview data with the products in the `skus` list. `--template` targets another email; `--name` sets the file name. |
| `init` | Sets up a single environment called `default`. `setup` does this and more. |

A template is named by its type ID (`combined_order_status_email`). A path to
its folder works too.

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
      email-builder.json                             optional team settings
      templates/global/<type_id>/body.html           the email body (Handlebars)
      templates/global/<type_id>/subject.hbs         the subject line
      templates/global/<type_id>/translations.json   phrases, keyed by locale
      fixtures/_global.json                          preview data shared by every email
      fixtures/<type_id>/default.json                preview data for one email
      fixtures/<type_id>/products.json               written by `fixture sku`

## Settings file

`theme-emails/email-builder.json` is optional and committed with the project.

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
template renders against. The shape for each email is in BigCommerce's
[email object reference](https://docs.bigcommerce.com/developer/docs/admin/store-configuration/emails/email-object-reference/global-email-object).

Starter fixtures ship for `combined_order_status_email` and
`account_reset_password_email`. Other emails start with an empty fixture to
fill in from that reference.

The customer, order number, tracking details and store name are made up. To
show your own store name or logo in the preview, edit `fixtures/_global.json`
by hand.

One command adds real, non-personal data:

- `fixture sku` looks up each SKU in the selected environment's catalog and
  writes `products.json`, one line item per SKU, quantity 1, total the sum of
  the prices. Choose "products" under Preview data to see it.

The preview never contacts the store. It reads these files, so rerun
`fixture sku` when the list, prices or images change.

## How the preview differs from a real email

BigCommerce has no API that renders a template, so the preview is a local
Handlebars render.

- `{{lang 'key' name=value}}` works: it reads `translations.json` for the
  selected language and fills `{name}` placeholders.
- The Handlebars built-ins (`if`, `unless`, `each`, `with`) work.
- Any other BigCommerce helper is not available. The preview highlights where
  it is used and lists a warning; check that part with a test email.

## Email client check

`lint` uses the support data from [caniemail.com](https://www.caniemail.com),
bundled in the `caniemail` npm package, and reports the line and column in
`body.html`:

    theme-emails/templates/global/combined_order_status_email/body.html
      4:13     display:flex  not supported in outlook (windows)

The same results show under the preview, and `publish` mentions them without
blocking. Run `npm update caniemail` in the tool's folder for newer data.

Limits: Handlebars tags are hidden from the checker, so markup that only
exists after rendering (for example HTML inside a phrase) is not checked.

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
