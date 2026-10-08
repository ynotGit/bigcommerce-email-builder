# bc-email-builder

Edit BigCommerce transactional emails in your own editor, preview them locally,
and publish them to your store.

## Install

Needs Node 22 or newer.

    npm install -g github:ynotGit/bc-email-builder

## First time

Run these from your project root (the folder that holds `theme-widgets`).

    email-builder setup staging production
    email-builder env use staging

`setup` asks for each store's hash and API token, then downloads the email
templates into a new `theme-emails/` folder. `env use` chooses which store
your commands point at. Nothing else runs until you have chosen one.

Commit `theme-emails/` to your repo. Credentials inside it are gitignored.

## Every day

    email-builder start

Open http://localhost:4321. Edit the files for an email and the preview
reloads when you save:

    theme-emails/templates/global/<email>/body.html           the email
    theme-emails/templates/global/<email>/subject.hbs         the subject line
    theme-emails/templates/global/<email>/translations.json   the phrases

When it looks right:

    email-builder publish combined_order_status_email

It shows what changed and asks before it writes to the store. Then send
yourself a test email from Marketing > Transactional Emails in the BigCommerce
admin, because the local preview is a close copy, not the real thing.

## Switching store

    email-builder env use production

Every command prints the store it is about to use. To run one command against
another store without switching, add `--env production`.

## Optional extras

| To | Run |
| --- | --- |
| Check for HTML and CSS that email clients do not support | `email-builder lint` |
| See which emails differ from the store | `email-builder status` |
| Show real products in the preview | Add `{ "skus": ["TOTE-NAT"] }` to `theme-emails/email-builder.json`, then `email-builder fixture sku` |

## Good to know

- The preview uses made-up customer and order details. The tool never reads
  orders or customers from your store.
- A teammate joining the project runs the same `setup` command to add their
  own credentials.
- The API token needs access to email templates. For `fixture sku` it also
  needs read access to products and store information (for the currency).

Everything else (all commands and options, settings, make targets, how the
preview differs from a real email) is in [docs/REFERENCE.md](docs/REFERENCE.md).
