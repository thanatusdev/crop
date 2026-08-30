import { API_URL } from "./config.js";
import { tokenStore } from "./token-store.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const refreshToken = tokenStore.getRefreshToken();
  if (!refreshToken) return false;

  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;

  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  tokenStore.setTokens(body.accessToken, body.refreshToken);
  return true;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean; // default true
}

function authHeader(): Record<string, string> {
  const token = tokenStore.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * A single 401 triggers exactly one refresh attempt, shared across concurrent callers via
 * `refreshInFlight` so five simultaneous requests don't trigger five refresh calls.
 */
async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const { method = "GET", body, auth = true } = options;

  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(auth ? authHeader() : {}) };
    return fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  };

  let res = await doFetch();

  if (res.status === 401 && auth) {
    refreshInFlight ??= refreshTokens().finally(() => {
      refreshInFlight = null;
    });
    const refreshed = await refreshInFlight;
    if (refreshed) {
      res = await doFetch();
    }
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ code: "UNKNOWN", message: res.statusText }));
    throw new ApiError(res.status, errorBody.code ?? "UNKNOWN", errorBody.message ?? res.statusText);
  }

  return res;
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => requestJson<T>(path),
  post: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => requestJson<T>(path, { ...opts, method: "POST", body }),
  /** For binary responses (snapshot images) -- everything else in the API returns JSON. */
  getBlob: async (path: string): Promise<Blob> => (await request(path)).blob(),
};
