# bc-email-builder

Edit BigCommerce transactional emails in your own editor, preview them locally,
and publish them to your store.

## Install

Needs Node 22 or newer. From your project root (the folder that holds
`theme-widgets`):

    npm install -D github:ynotGit/bigcommerce-email-builder

This adds the tool to your project's dev dependencies, so its commands run
through `npx`. To update to the latest version, run the same command again.

## API account

Each store needs a store-level API account: in the BigCommerce admin, go to
Settings > Store-level API accounts and create one with the token type
"V2/V3 API token". These are the only scopes it needs; leave the rest on None.

| Scope | Level | Used for |
| --- | --- | --- |
| Information & settings | modify | Downloading and publishing the email templates, and `fixture store` |
| Products | read-only | `fixture sku`, and only that |

Read-only on Information & settings is enough for an account that previews
but never publishes. Keep the store hash (or the API path) and the access
token it shows you; the client ID and secret are not used.

## First time

From the same folder:

    npx email-builder setup staging production
    npx email-builder env use staging
    npx email-builder fixture store

`setup` asks for each store's hash and API token, then downloads the email
templates into a new `theme-emails/` folder. `env use` chooses which store
your commands point at. Nothing else runs until you have chosen one.
`fixture store` puts that store's name, logo and image paths into the
preview; without it the logo and icons in the emails show as broken images.

Commit `theme-emails/` to your repo. Credentials inside it are gitignored.

## Every day

    npx email-builder start

Open http://localhost:4321. Edit the files for an email and the preview
reloads when you save:

    theme-emails/templates/global/<email>/body.html           the email
    theme-emails/templates/global/<email>/subject.hbs         the subject line
    theme-emails/templates/global/<email>/translations.json   the phrases

When it looks right:

    npx email-builder publish combined_order_status_email

It shows what changed and asks before it writes to the store. Then send
yourself a test email from Marketing > Transactional Emails in the BigCommerce
admin, because the local preview is a close copy, not the real thing.

## Switching store

    npx email-builder env use production

Every command prints the store it is about to use. To run one command against
another store without switching, add `--env production`.

## Optional extras

| To | Run |
| --- | --- |
| Check for HTML and CSS that email clients do not support | `npx email-builder lint` |
| See which emails differ from the store | `npx email-builder status` |
| Show real products in the preview | Add `{ "skus": ["TOTE-NAT"] }` to `theme-emails/email-builder.json`, then `npx email-builder fixture sku` |

## Good to know

- The preview uses made-up customer and order details. The tool never reads
  orders or customers from your store.
- A teammate joining the project runs `npm install`, then the same `setup`
  command to add their own credentials.

Everything else (all commands and options, settings, make targets, how the
preview differs from a real email) is in [docs/REFERENCE.md](docs/REFERENCE.md).
