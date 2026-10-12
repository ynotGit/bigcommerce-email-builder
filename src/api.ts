import { requireCredentials } from './config.js';
import type { Config, RemoteTemplate } from './types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long the store gets to answer one request. BC_API_TIMEOUT_MS changes it, for a slow connection. */
const TIMEOUT_MS = Number(process.env.BC_API_TIMEOUT_MS) || 30_000;

/** fetch says only "fetch failed"; the reason (no network, a mistyped host, a refused connection) is tucked away in its cause. */
function unreachable(url: URL, err: unknown): Error {
  if ((err as Error).name === 'TimeoutError') {
    return new Error(`No answer from ${url.host} after ${TIMEOUT_MS / 1000} seconds. Check your internet connection and try again.`);
  }
  const cause = (err as { cause?: { message?: string; code?: string; errors?: { message?: string }[] } }).cause;
  const why = cause?.message || cause?.errors?.[0]?.message || cause?.code || (err as Error).message;
  return new Error(`Could not reach ${url.host} (${why}). Check your internet connection and try again.`);
}

interface RequestOptions {
  method?: 'GET' | 'PUT';
  body?: unknown;
  query?: Record<string, string | null | undefined>;
}

/** Minimal BigCommerce REST client. `path` starts with /v2 or /v3. Resolves to null on an empty response. */
export async function bc<T>(config: Config, path: string, options: RequestOptions = {}): Promise<T | null> {
  requireCredentials(config);
  const { method = 'GET', body, query } = options;
  const url = new URL(`${config.apiBase}/stores/${config.storeHash}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  // The time limit covers the whole exchange, the body included, so a connection that stalls halfway ends too.
  const send = async (): Promise<{ res: Response; text: string }> => {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Auth-Token': config.token,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { res, text: await res.text() };
  };
  for (let attempt = 0; ; attempt++) {
    const { res, text } = await send().catch((err: unknown) => { throw unreachable(url, err); });
    if (res.status === 429 && attempt < 3) {
      await sleep(Number(res.headers.get('x-rate-limit-time-reset-ms')) || 1500);
      continue;
    }
    if (!res.ok) {
      const hint =
        res.status === 401 ? ' Check BC_ACCESS_TOKEN.'
        : res.status === 403 ? ' The API account is missing a scope this call needs.'
        : res.status === 404 ? ' Check the store hash.'
        : '';
      // An unknown store gets BigCommerce's 404 web page, which says nothing a person can use.
      const detail = /^\s*</.test(text) ? '' : `\n${text.slice(0, 500)}`;
      throw new Error(`${method} ${url.pathname} failed with ${res.status}.${hint}${detail}`);
    }
    if (!text) return null; // an empty answer, as a 204 is
    return JSON.parse(text) as T;
  }
}

const channelQuery = (config: Config) => (config.channelId ? { channel_id: config.channelId } : undefined);

export async function listRemoteTemplates(config: Config): Promise<RemoteTemplate[]> {
  const res = await bc<{ data?: RemoteTemplate[] }>(config, '/v3/marketing/email-templates', {
    query: channelQuery(config),
  });
  return res?.data ?? [];
}

export async function putRemoteTemplate(config: Config, template: RemoteTemplate): Promise<void> {
  await bc(config, `/v3/marketing/email-templates/${encodeURIComponent(template.type_id)}`, {
    method: 'PUT',
    query: channelQuery(config),
    body: template,
  });
}
