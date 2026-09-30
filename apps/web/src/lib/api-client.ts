import { API_URL } from "./config.js";
import { tokenStore } from "./token-store.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /**
     * Per-field validation failures, when the API rejected the request body against a Zod
     * schema. Empty for every other kind of error. Lets a form highlight the offending inputs
     * instead of only showing one combined sentence.
     */
    public readonly fieldErrors: readonly { path: string; message: string }[] = []
  ) {
    super(message);
  }
}

/**
 * Turns whatever the API put in `message` into one human-readable string.
 *
 * `ZodValidationPipe` answers a 400 with an *array* of `{path, message}` objects, not a string.
 * Passing that array straight to `new Error(...)` stringifies it as
 * "[object Object],[object Object]" -- which is what every form in this app displayed on any
 * validation error, since they all render `err.message` directly. Found while building the
 * equipment form, whose optional DICOM fields make a field-level 400 an ordinary occurrence
 * rather than a rarity.
 */
function describeError(body: { message?: unknown; code?: unknown }, fallback: string): { message: string; fieldErrors: { path: string; message: string }[] } {
  const raw = body.message;
  if (typeof raw === "string" && raw.length > 0) return { message: raw, fieldErrors: [] };

  if (Array.isArray(raw)) {
    const fieldErrors = raw
      .filter((issue): issue is { path?: unknown; message?: unknown } => typeof issue === "object" && issue !== null)
      .map((issue) => ({
        // `path` is Zod's array of segments (`["dicomPort"]`, or nested); joined with "." so a
        // nested field reads the way it would be written in code.
        path: Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? ""),
        message: String(issue.message ?? ""),
      }));
    if (fieldErrors.length > 0) {
      return {
        message: fieldErrors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join("; "),
        fieldErrors,
      };
    }
  }

  return { message: fallback, fieldErrors: [] };
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
  /** When the body is `FormData` (a multipart upload -- see `api.postForm`), `fetch` must set
   * its own `Content-Type` (with the multipart boundary the browser generated) rather than
   * this client forcing `application/json` and JSON-stringifying an object that isn't one. */
  isFormData?: boolean;
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
  const { method = "GET", body, auth = true, isFormData = false } = options;

  const doFetch = (): Promise<Response> => {
    const headers: Record<string, string> = { ...(auth ? authHeader() : {}) };
    if (isFormData) {
      return fetch(`${API_URL}${path}`, { method, headers, body: body as FormData });
    }
    headers["Content-Type"] = "application/json";
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
    const { message, fieldErrors } = describeError(errorBody, res.statusText);
    throw new ApiError(res.status, errorBody.code ?? "UNKNOWN", message, fieldErrors);
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
  patch: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => requestJson<T>(path, { ...opts, method: "PATCH", body }),
  /** `PUT` for the one route that genuinely replaces a whole collection rather than merging into it
   * (`PUT /agreements/:id/scope` -- see SetAgreementScopeRequestSchema). Kept distinct from `patch`
   * so the call site reads as the full-replacement it is. */
  put: <T>(path: string, body?: unknown, opts: RequestOptions = {}) => requestJson<T>(path, { ...opts, method: "PUT", body }),
  /** `POST` with a `multipart/form-data` body -- the one write in this app that isn't plain
   * JSON (`POST /chat/messages`, when it carries a file). See `RequestOptions.isFormData`. */
  postForm: <T>(path: string, formData: FormData) => requestJson<T>(path, { method: "POST", body: formData, isFormData: true }),
  /** For binary responses (snapshot images) -- everything else in the API returns JSON. */
  getBlob: async (path: string): Promise<Blob> => (await request(path)).blob(),
};
