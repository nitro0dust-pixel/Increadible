/**
 * Real HTTP calls for the API gateway (opt-in; see `GATEWAY_LIVE_APIS`).
 *
 * The `endpoint` and `params` of a `call_api` come from a model, so they are untrusted input. This module is where they are
 * turned into a request, and it is written around what they must NOT be able to do:
 *   - reach another host or path outside the API's registered URL (SSRF, `..`, encoded dots or slashes, a full URL);
 *   - set or override the credential (the gateway adds it itself, from the environment);
 *   - make the gateway follow a redirect to somewhere else;
 *   - put a credential into a result, an error message, a log line or a cache key.
 * Only GET is sent, only JSON is accepted, and time and size are capped.
 */

/** Where the gateway puts an API's credential. The value is read from the environment variable `env` at call time. */
export interface Credential {
  env: string;
  in: "query" | "header";
  name: string;
}

export interface LiveOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  userAgent: string;
}

/** An error whose message is safe to show to the model and to log: it never contains a credential. */
export class LiveCallError extends Error {}

const MAX_ENDPOINT_LENGTH = 512;
const MAX_PARAMS = 30;
const MAX_PARAM_VALUE_LENGTH = 1024;
const MAX_ERROR_BODY_CHARS = 200;

/** Replace every occurrence of a secret (plain or URL-encoded) in `text`. Secrets shorter than 4 characters are not searched for. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join("[redacted]");
  }
  return out;
}

/**
 * The URL for `endpoint` under the API's registered URL `baseUrl`, with `params` as the query.
 * `reservedQueryName` is the query parameter the gateway fills with the credential; a caller may not set it.
 */
export function buildRequestUrl(baseUrl: string, endpoint: unknown, params: unknown, reservedQueryName?: string): URL {
  if (typeof endpoint !== "string") throw new LiveCallError("endpoint must be a string");
  if (endpoint.length > MAX_ENDPOINT_LENGTH) throw new LiveCallError(`endpoint is longer than ${MAX_ENDPOINT_LENGTH} characters`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(endpoint) || endpoint.startsWith("//")) {
    throw new LiveCallError("endpoint must be a path under the API's registered URL, not a URL");
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this check
  if (/[\x00-\x20\x7f\\?#]/.test(endpoint)) {
    throw new LiveCallError("endpoint must be a plain path without spaces, backslashes, '?' or '#'; pass query parameters in params");
  }
  if (/%(2e|2f|5c|00)/i.test(endpoint)) throw new LiveCallError("endpoint may not contain encoded dots, slashes or null bytes");
  if (endpoint.split("/").some((segment) => segment === "." || segment === "..")) throw new LiveCallError("endpoint may not contain '.' or '..' segments");

  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(base.href);
  // An empty endpoint, or a bare '/', is the registered URL itself (an API such as /w/api.php is the whole endpoint, and
  // /w/api.php/ would not be the same resource).
  const rest = endpoint.replace(/^\/+/, "");
  url.pathname = rest === "" ? base.pathname : `${basePath}/${rest}`;
  // Whatever the URL parser made of it, the request must stay on the registered host and under the registered path.
  if (url.origin !== base.origin || !(url.pathname === base.pathname || url.pathname.startsWith(`${basePath}/`))) {
    throw new LiveCallError("endpoint leaves the API's registered URL");
  }

  if (params !== undefined && params !== null) {
    if (typeof params !== "object" || Array.isArray(params)) throw new LiveCallError("params must be an object");
    const entries = Object.entries(params as Record<string, unknown>);
    if (entries.length > MAX_PARAMS) throw new LiveCallError(`params has more than ${MAX_PARAMS} entries`);
    for (const [key, value] of entries) {
      if (!/^[A-Za-z0-9_.\-[\]]{1,64}$/.test(key)) throw new LiveCallError("params keys must be 1 to 64 letters, digits or _ . - [ ]");
      if (reservedQueryName !== undefined && key.toLowerCase() === reservedQueryName.toLowerCase()) {
        throw new LiveCallError(`params may not set '${reservedQueryName}': the gateway adds the credential itself`);
      }
      const ok = typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
      if (!ok) throw new LiveCallError(`params.${key} must be a string, a finite number or a boolean`);
      const text = String(value);
      if (text.length > MAX_PARAM_VALUE_LENGTH) throw new LiveCallError(`params.${key} is longer than ${MAX_PARAM_VALUE_LENGTH} characters`);
      url.searchParams.append(key, text);
    }
  }
  return url;
}

/** Read at most `max` bytes of the body; fails (and stops reading) when it is larger. */
async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new LiveCallError(`response is larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * GET `url` and return the parsed JSON. `credential` (the value, if any) is sent as a header here, or already in `url`'s query;
 * either way it is scrubbed from every message this function can produce.
 */
export async function liveGet(
  url: URL,
  headers: Record<string, string>,
  options: LiveOptions,
  secrets: string[]
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": options.userAgent, ...headers },
      redirect: "manual", // a redirect could send the request (and the credential) to another host
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error: any) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new LiveCallError(`timed out after ${options.timeoutMs} ms`);
    // error.message of a failed fetch can contain the URL, and with it the credential: report only the error code.
    const code = typeof error?.cause?.code === "string" ? error.cause.code : "unknown";
    throw new LiveCallError(`network error (${code})`);
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new LiveCallError(`the API answered with a redirect (HTTP ${response.status}), which is not followed`);
  }

  const text = await readCapped(response, options.maxResponseBytes);

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const body = redact(text, secrets).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_BODY_CHARS);
    throw new LiveCallError(
      `HTTP ${response.status}${response.status === 429 && retryAfter ? ` (retry after ${retryAfter.slice(0, 40)})` : ""}${body ? `: ${body}` : ""}`
    );
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!/(^|[/+])json(\s*;|$)/.test(contentType)) {
    throw new LiveCallError(`the response is not JSON (content-type: ${contentType.slice(0, 60) || "none"})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LiveCallError("the response is not valid JSON");
  }
}
