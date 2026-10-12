// Which build this is: the package's version and, where it can be found, the
// commit it came from. Installs come straight from the main branch, so between
// two version bumps the commit is the only thing that tells builds apart.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, installProject } from './config.js';

/** For an install inside a project: the commit npm recorded when it fetched the tool from GitHub. */
function installedCommit(): string | null {
  const project = installProject();
  if (!project) return null;
  const key = path.relative(project, PACKAGE_ROOT).split(path.sep).join('/'); // "node_modules/bc-email-builder"
  // node_modules/.package-lock.json describes what is installed right now; package-lock.json what should be.
  for (const file of [path.join(project, 'node_modules', '.package-lock.json'), path.join(project, 'package-lock.json')]) {
    try {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as { packages?: Record<string, { resolved?: string }> };
      const commit = /#([0-9a-f]{7,40})$/.exec(lock.packages?.[key]?.resolved ?? '')?.[1];
      if (commit) return commit.slice(0, 7);
    } catch { /* no lockfile, or not npm's: the version is shown without a commit */ }
  }
  return null;
}

/** For a checkout of the tool's own repository, as when working on it: the commit it is on. */
function checkoutCommit(): string | null {
  if (!fs.existsSync(path.join(PACKAGE_ROOT, '.git'))) return null;
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** "0.12.0 (5392e1c)", or the version alone when the commit cannot be told. */
export function version(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  const commit = installedCommit() ?? checkoutCommit();
  return commit ? `${pkg.version} (${commit})` : pkg.version;
}
