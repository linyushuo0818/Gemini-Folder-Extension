import { isRecord } from '../shared/storage';
import { DRIVE_AUTH_STORAGE_KEY, DRIVE_SYNC_FILENAME } from '../shared/sync';
import type { StorageAreaLike } from './cloudSync';

export const GOOGLE_DRIVE_CLIENT_ID =
  '857461067481-jqpopvqnfqcgdiq8vhsdukbh96jn3gvk.apps.googleusercontent.com';
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const LIST_SYNC_FILES_URL =
  `${DRIVE_FILES_API}?spaces=appDataFolder` +
  `&q=name%3D%27${DRIVE_SYNC_FILENAME}%27+and+trashed%3Dfalse` +
  `&fields=files(id,modifiedTime,version)&orderBy=createdTime`;
const TOKEN_EXPIRY_BUFFER_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 600;

export const DRIVE_SESSION_EXPIRED_MESSAGE = 'Google Drive session expired. Please reconnect.';

export type DriveAuthErrorCode = 'auth_expired' | 'auth_cancelled' | 'auth_failed' | 'unavailable';

export class DriveAuthError extends Error {
  public readonly code: DriveAuthErrorCode;

  constructor(code: DriveAuthErrorCode, message: string) {
    super(message);
    this.name = 'DriveAuthError';
    this.code = code;
  }
}

export class DriveApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
  }
}

export interface IdentityAuthLike {
  getRedirectURL: (path?: string) => string;
  launchWebAuthFlow: (details: { url: string; interactive: boolean }) => Promise<string | undefined>;
}

export interface DriveAuthToken {
  accessToken: string;
  expiresAt: number;
}

export interface DriveFileMeta {
  id: string;
  modifiedTime?: string;
  version?: string;
}

export type DriveFileReadResult =
  | { kind: 'not_found' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'found'; content: unknown; rawBytes: number };

export interface GoogleDriveClientOptions {
  local: StorageAreaLike;
  identity: IdentityAuthLike | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  generateState?: () => string;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  retryDelayMs?: number;
}

export function buildGoogleOAuthUrl(redirectUri: string, state: string, interactive: boolean): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_DRIVE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GOOGLE_DRIVE_SCOPE,
    state,
    include_granted_scopes: 'true'
  });
  if (!interactive) {
    params.set('prompt', 'none');
  }
  return `${GOOGLE_OAUTH_AUTH_URL}?${params.toString()}`;
}

export function parseGoogleOAuthRedirect(
  redirectUrl: string,
  expectedState: string,
  now: number,
  interactive: boolean
): DriveAuthToken {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    throw new DriveAuthError(
      interactive ? 'auth_failed' : 'auth_expired',
      interactive ? 'Invalid Google Drive sign-in response.' : DRIVE_SESSION_EXPIRED_MESSAGE
    );
  }

  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  const hashParams = new URLSearchParams(hash);
  const error = hashParams.get('error') || parsed.searchParams.get('error');
  if (error) {
    if (!interactive || error === 'interaction_required' || error === 'login_required' || error === 'consent_required') {
      throw new DriveAuthError('auth_expired', DRIVE_SESSION_EXPIRED_MESSAGE);
    }
    if (error === 'access_denied') {
      throw new DriveAuthError('auth_cancelled', 'Google Drive sign-in was cancelled.');
    }
    throw new DriveAuthError('auth_failed', `Google Drive sign-in failed (${error}).`);
  }

  const state = hashParams.get('state');
  if (!state || state !== expectedState) {
    throw new DriveAuthError('auth_failed', 'Google Drive sign-in verification failed.');
  }

  const accessToken = hashParams.get('access_token')?.trim();
  if (!accessToken) {
    throw new DriveAuthError(
      interactive ? 'auth_failed' : 'auth_expired',
      interactive ? 'Google Drive did not return an access token.' : DRIVE_SESSION_EXPIRED_MESSAGE
    );
  }

  const expiresInRaw = Number(hashParams.get('expires_in'));
  const expiresInSeconds = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;
  return {
    accessToken,
    expiresAt: now + Math.floor(expiresInSeconds * 1000)
  };
}

function sanitizeStoredToken(raw: unknown): DriveAuthToken | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.accessToken !== 'string' || !raw.accessToken.trim()) return null;
  if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0) return null;
  return { accessToken: raw.accessToken.trim(), expiresAt: raw.expiresAt };
}

function isUserCancelledMessage(message: string): boolean {
  return /did not approve|canceled|cancelled|closed|user_cancelled/i.test(message);
}

function isExplicitAuthExpiredMessage(message: string): boolean {
  return /interaction_required|login_required|consent_required|user interaction|not approve|access_denied|invalid_grant/i.test(
    message
  );
}

function isTransientAuthNetworkError(message: string): boolean {
  return (
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    /could not be loaded|network|offline|internet|failed to fetch|timed? ?out|err_internet|err_name_not_resolved|err_connection/i.test(
      message
    )
  );
}

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseDriveVersion(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return String(raw);
  }
  return undefined;
}

export class GoogleDriveSyncClient {
  private readonly local: StorageAreaLike;
  private readonly identity: IdentityAuthLike | null;
  private readonly fetchFn: typeof fetch;
  private readonly clockNow: () => number;
  private readonly generateState: () => string;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: GoogleDriveClientOptions) {
    this.local = options.local;
    this.identity = options.identity;
    this.fetchFn = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.clockNow = options.now ?? (() => Date.now());
    this.generateState = options.generateState ?? (() => crypto.randomUUID());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  public get available(): boolean {
    return this.identity !== null;
  }

  public async readCachedToken(): Promise<DriveAuthToken | null> {
    const stored = await this.local.get(DRIVE_AUTH_STORAGE_KEY);
    return sanitizeStoredToken(stored[DRIVE_AUTH_STORAGE_KEY]);
  }

  public async clearToken(): Promise<void> {
    await this.local.remove(DRIVE_AUTH_STORAGE_KEY);
  }

  public async authenticate(interactive: boolean): Promise<DriveAuthToken> {
    if (!this.identity) {
      throw new DriveAuthError('unavailable', 'Google Drive sync is unavailable in this browser.');
    }
    const state = this.generateState();
    const redirectUri = this.identity.getRedirectURL();
    const url = buildGoogleOAuthUrl(redirectUri, state, interactive);

    let redirectUrl: string | undefined;
    try {
      redirectUrl = await this.identity.launchWebAuthFlow({ url, interactive });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!interactive) {
        if (isTransientAuthNetworkError(message) && !isExplicitAuthExpiredMessage(message)) {
          throw new DriveAuthError(
            'auth_failed',
            'Could not reach Google Drive. Check your network and try again.'
          );
        }
        throw new DriveAuthError('auth_expired', DRIVE_SESSION_EXPIRED_MESSAGE);
      }
      if (isUserCancelledMessage(message)) {
        throw new DriveAuthError('auth_cancelled', 'Google Drive sign-in was cancelled.');
      }
      throw new DriveAuthError('auth_failed', message || 'Google Drive sign-in failed.');
    }

    if (!redirectUrl) {
      throw new DriveAuthError(
        interactive ? 'auth_cancelled' : 'auth_expired',
        interactive ? 'Google Drive sign-in was cancelled.' : DRIVE_SESSION_EXPIRED_MESSAGE
      );
    }

    const token = parseGoogleOAuthRedirect(redirectUrl, state, this.clockNow(), interactive);
    await this.local.set({ [DRIVE_AUTH_STORAGE_KEY]: token });
    return token;
  }

  private async getValidToken(): Promise<DriveAuthToken> {
    const cached = await this.readCachedToken();
    if (cached && cached.expiresAt - this.clockNow() > TOKEN_EXPIRY_BUFFER_MS) {
      return cached;
    }
    try {
      return await this.authenticate(false);
    } catch (error) {
      if (error instanceof DriveAuthError && (error.code === 'unavailable' || error.code === 'auth_failed')) {
        throw error;
      }
      await this.clearToken();
      throw new DriveAuthError('auth_expired', DRIVE_SESSION_EXPIRED_MESSAGE);
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new Error('Google Drive request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private computeRetryDelayMs(response?: Response): number {
    if (this.retryDelayMs <= 0) return 0;
    if (response) {
      const retryAfter = response.headers.get('Retry-After')?.trim();
      if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
          return Math.min(Math.round(seconds * 1000), 3000);
        }
      }
    }
    return this.retryDelayMs;
  }

  private async authorizedFetch(
    url: string,
    init: RequestInit = {},
    options: { timeoutMs?: number; retryable?: boolean } = {}
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const retryable = options.retryable ?? false;
    let token = await this.getValidToken();
    let hasRenewedAuth = false;
    let hasRetriedTransient = false;

    while (true) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${token.accessToken}`);

      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, { ...init, headers }, timeoutMs);
      } catch (error) {
        if (!retryable || hasRetriedTransient || error instanceof DriveAuthError) {
          throw error;
        }
        hasRetriedTransient = true;
        const delayMs = this.computeRetryDelayMs();
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (response.status === 401) {
        if (hasRenewedAuth) {
          await this.clearToken();
          throw new DriveAuthError('auth_expired', DRIVE_SESSION_EXPIRED_MESSAGE);
        }
        hasRenewedAuth = true;
        // Token 被吊销或提前过期时，清理本地缓存并静默续签重试一次；绝不主动弹出交互窗口。
        await this.clearToken();
        try {
          token = await this.authenticate(false);
        } catch (error) {
          if (error instanceof DriveAuthError && (error.code === 'unavailable' || error.code === 'auth_failed')) {
            throw error;
          }
          throw new DriveAuthError('auth_expired', DRIVE_SESSION_EXPIRED_MESSAGE);
        }
        continue;
      }

      if (retryable && !hasRetriedTransient && isTransientHttpStatus(response.status)) {
        hasRetriedTransient = true;
        const delayMs = this.computeRetryDelayMs(response);
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return response;
    }
  }

  public async listSyncFiles(): Promise<DriveFileMeta[]> {
    const response = await this.authorizedFetch(
      LIST_SYNC_FILES_URL,
      { method: 'GET' },
      { timeoutMs: this.requestTimeoutMs, retryable: true }
    );
    if (!response.ok) {
      throw new DriveApiError(response.status, `Google Drive list failed (HTTP ${response.status}).`);
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.files)) {
      throw new DriveApiError(response.status, 'Unexpected Google Drive file list response.');
    }
    const files: DriveFileMeta[] = [];
    for (const item of data.files) {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
      files.push({
        id: item.id.trim(),
        modifiedTime: typeof item.modifiedTime === 'string' ? item.modifiedTime : undefined,
        version: parseDriveVersion(item.version)
      });
    }
    return files;
  }

  public async readSyncFile(fileId: string): Promise<DriveFileReadResult> {
    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`;
    const response = await this.authorizedFetch(
      url,
      { method: 'GET' },
      { timeoutMs: this.requestTimeoutMs, retryable: true }
    );
    if (response.status === 404) {
      return { kind: 'not_found' };
    }
    if (!response.ok) {
      throw new DriveApiError(response.status, `Google Drive download failed (HTTP ${response.status}).`);
    }
    const text = await response.text();
    const rawBytes = new TextEncoder().encode(text).byteLength;
    try {
      return { kind: 'found', content: JSON.parse(text) as unknown, rawBytes };
    } catch {
      return { kind: 'corrupt', reason: 'Google Drive sync file is corrupted.' };
    }
  }

  public async createSyncFile(jsonBody: string): Promise<DriveFileMeta> {
    const boundary = `gp_drive_sync_${this.generateState().replace(/[^a-zA-Z0-9]/g, '')}`;
    const metadata = JSON.stringify({
      name: DRIVE_SYNC_FILENAME,
      parents: ['appDataFolder']
    });
    const multipartBody =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${jsonBody}\r\n` +
      `--${boundary}--`;

    const response = await this.authorizedFetch(
      `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,modifiedTime,version`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      },
      { timeoutMs: this.uploadTimeoutMs, retryable: false }
    );
    if (!response.ok) {
      throw new DriveApiError(response.status, `Google Drive upload failed (HTTP ${response.status}).`);
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || typeof data.id !== 'string' || !data.id.trim()) {
      throw new DriveApiError(response.status, 'Google Drive did not return a file ID.');
    }
    return {
      id: data.id.trim(),
      modifiedTime: typeof data.modifiedTime === 'string' ? data.modifiedTime : undefined,
      version: parseDriveVersion(data.version)
    };
  }

  public async updateSyncFile(
    fileId: string,
    jsonBody: string
  ): Promise<{ notFound: true } | { notFound: false; modifiedTime?: string; version?: string }> {
    const url = `${DRIVE_UPLOAD_API}/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime,version`;
    const response = await this.authorizedFetch(
      url,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8'
        },
        body: jsonBody
      },
      { timeoutMs: this.uploadTimeoutMs, retryable: true }
    );
    if (response.status === 404) {
      return { notFound: true };
    }
    if (!response.ok) {
      throw new DriveApiError(response.status, `Google Drive update failed (HTTP ${response.status}).`);
    }
    let modifiedTime: string | undefined;
    let version: string | undefined;
    try {
      const data: unknown = await response.json();
      if (isRecord(data)) {
        if (typeof data.modifiedTime === 'string') {
          modifiedTime = data.modifiedTime;
        }
        version = parseDriveVersion(data.version);
      }
    } catch {
      // Some responses may omit JSON body; ignore safely.
    }
    return { notFound: false, modifiedTime, version };
  }

  public async deleteFile(fileId: string): Promise<void> {
    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}`;
    const response = await this.authorizedFetch(
      url,
      { method: 'DELETE' },
      { timeoutMs: this.requestTimeoutMs, retryable: true }
    );
    if (response.status === 404 || response.status === 204 || response.ok) {
      return;
    }
    throw new DriveApiError(response.status, `Google Drive cleanup failed (HTTP ${response.status}).`);
  }
}
