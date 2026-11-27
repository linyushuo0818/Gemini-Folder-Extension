type AnyFn = (...args: any[]) => any;

const globalApi = globalThis as typeof globalThis & {
  browser?: any;
  chrome?: any;
};

export const webext = globalApi.chrome ?? globalApi.browser;

function requireWebext() {
  const api = globalApi.chrome ?? globalApi.browser ?? webext;
  if (!api) {
    throw new Error('WebExtension API is not available in this environment.');
  }
  return api;
}

function invokeCompat<T>(fn: AnyFn, args: unknown[]): Promise<T> {
  try {
    const maybePromise = fn(...args);
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise as Promise<T>;
    }
  } catch {
    // Fall through to callback mode for Chrome APIs.
  }

  return new Promise<T>((resolve, reject) => {
    fn(...args, (value: T) => {
      const runtimeError = globalApi.chrome?.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'WebExtension API call failed.'));
        return;
      }
      resolve(value);
    });
  });
}

export function storageLocalGet<T = Record<string, unknown>>(
  keys?: string | string[] | Record<string, unknown> | null
): Promise<T> {
  const local = requireWebext().storage.local;
  return invokeCompat<T>(local.get.bind(local), keys === undefined ? [] : [keys]);
}

export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  const local = requireWebext().storage.local;
  return invokeCompat<void>(local.set.bind(local), [items]);
}

export function storageLocalRemove(keys: string | string[]): Promise<void> {
  const local = requireWebext().storage.local;
  return invokeCompat<void>(local.remove.bind(local), [keys]);
}

export function hasIdentityWebAuthFlow(): boolean {
  const api = globalApi.chrome ?? globalApi.browser ?? webext;
  return Boolean(
    typeof api?.identity?.launchWebAuthFlow === 'function' &&
    typeof api?.identity?.getRedirectURL === 'function'
  );
}

export function identityGetRedirectURL(path?: string): string {
  const identity = requireWebext().identity;
  if (typeof identity?.getRedirectURL !== 'function') {
    throw new Error('Identity API is not available in this browser.');
  }
  return path === undefined ? identity.getRedirectURL() : identity.getRedirectURL(path);
}

export function identityLaunchWebAuthFlow(details: {
  url: string;
  interactive: boolean;
}): Promise<string | undefined> {
  const identity = requireWebext().identity;
  if (typeof identity?.launchWebAuthFlow !== 'function') {
    throw new Error('Identity API is not available in this browser.');
  }
  return invokeCompat<string | undefined>(identity.launchWebAuthFlow.bind(identity), [details]);
}

export function runtimeSendMessage<TResponse = unknown>(message: unknown): Promise<TResponse> {
  const runtime = requireWebext().runtime;
  return invokeCompat<TResponse>(runtime.sendMessage.bind(runtime), [message]);
}

export function runtimeLastErrorMessage(): string | null {
  const error = globalApi.chrome?.runtime?.lastError ?? webext?.runtime?.lastError;
  return error?.message || null;
}
