type AnyFn = (...args: any[]) => any;

const globalApi = globalThis as typeof globalThis & {
  browser?: any;
  chrome?: any;
};

export const webext = globalApi.chrome ?? globalApi.browser;

if (!webext) {
  throw new Error('WebExtension API is not available in this environment.');
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
  keys?: string | string[] | Record<string, unknown>
): Promise<T> {
  return invokeCompat<T>(webext.storage.local.get.bind(webext.storage.local), [keys]);
}

export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  return invokeCompat<void>(webext.storage.local.set.bind(webext.storage.local), [items]);
}

export function runtimeSendMessage<TResponse = unknown>(message: unknown): Promise<TResponse> {
  return invokeCompat<TResponse>(webext.runtime.sendMessage.bind(webext.runtime), [message]);
}

export function runtimeLastErrorMessage(): string | null {
  const error = globalApi.chrome?.runtime?.lastError ?? webext.runtime?.lastError;
  return error?.message || null;
}
