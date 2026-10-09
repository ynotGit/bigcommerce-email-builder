// BigCommerce's API knows each email by a type ID (combined_order_status_email),
// but the admin lists it under a friendlier name (Order Status Update). Folders
// on disk use the admin name in kebab-case so they are easy to match by eye.
// Everything sent to the API still uses the type ID.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './types.js';

/** Names as they read under Marketing > Transactional Emails in the admin. The API does not return them. */
const ADMIN_NAMES: Record<string, string> = {
  abandoned_cart_email: 'Abandoned Cart',
  account_details_changed_email: 'Account Settings Edited',
  account_reset_password_email: 'Password Reset',
  combined_order_status_email: 'Order Status Update',
  createaccount_email: 'Account Created',
  createguestaccount_email: 'Guest Account Created',
  giftcertificate_email: 'Gift Certificate Recipient',
  guest_order_access_email: 'Guest Order Access',
  invoice_email: 'Order Email',
  order_ready_for_pickup: 'Order ready for pickup',
  ordermessage_notification: 'Order Notification',
  passwordless_login_email: 'Sign-in Link Request',
  product_review_email: 'Product Review Request',
  return_confirmation_email: 'Return Requested',
  return_statuschange_email: 'Return Status Change',
};

const kebab = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const FOLDERS = new Map(Object.entries(ADMIN_NAMES).map(([typeId, name]) => [typeId, kebab(name)]));
const TYPE_IDS = new Map([...FOLDERS].map(([typeId, folder]) => [folder, typeId]));

// An email this list has not caught up with keeps its type ID as its name and folder.

/** The admin's name for an email: "Order Status Update". */
export const adminName = (typeId: string): string => ADMIN_NAMES[typeId] ?? typeId;

/** The folder an email lives in, under templates/<scope>/ and fixtures/: "order-status-update". */
export const folderName = (typeId: string): string => FOLDERS.get(typeId) ?? typeId;

/** Takes a folder name, an admin name or a type ID, so commands accept any of them. */
export const toTypeId = (name: string): string => TYPE_IDS.get(kebab(name)) ?? name;

/**
 * Projects set up before folders took the admin names have them under type
 * IDs. Renames those in place, in every scope's templates and in fixtures, and
 * returns the new paths. A folder is left alone if the new name is already taken.
 */
export function renameLegacyFolders(config: Config): string[] {
  const templates = path.join(config.root, 'templates');
  const scopes = fs.existsSync(templates)
    ? fs.readdirSync(templates, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(templates, entry.name))
    : [];
  const renamed: string[] = [];
  for (const parent of [...scopes, config.fixturesDir]) {
    for (const [typeId, folder] of FOLDERS) {
      const from = path.join(parent, typeId);
      const to = path.join(parent, folder);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
      renamed.push(to);
    }
  }
  return renamed;
}
