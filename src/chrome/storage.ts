/**
 * The only place `chrome.storage` is called.
 *
 * Every read and write checks `chrome.runtime.lastError` and turns it into a
 * `Result`. Storage has a 10 MB ceiling and no `unlimitedStorage` permission, so
 * a full area is a normal condition to handle, not an exceptional one — before
 * this, `set()` failed silently at the limit and the UI carried on as if the
 * step had been saved.
 */

import { flowError, isQuotaMessage } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import type { LocalStorageShape, SyncStorageShape } from '../shared/types.js';

/** Reads never fail loudly enough to block the UI, but they are still reported. */
function read<T>(area: chrome.storage.StorageArea, keys: string | string[] | null): Promise<Result<T>> {
  return new Promise((resolve) => {
    area.get(keys, (items) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve(err(flowError('STORAGE_READ', lastError.message)));
        return;
      }
      resolve(ok(items as T));
    });
  });
}

function write(
  area: chrome.storage.StorageArea,
  items: Record<string, unknown>,
): Promise<Result<void>> {
  return new Promise((resolve) => {
    area.set(items, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve(err(flowError(isQuotaMessage(lastError.message) ? 'STORAGE_QUOTA' : 'STORAGE_WRITE', lastError.message)));
        return;
      }
      resolve(ok());
    });
  });
}

export function getLocal(
  keys: string | string[],
): Promise<Result<Partial<LocalStorageShape> & Record<string, unknown>>> {
  return read(chrome.storage.local, keys);
}

export function setLocal(
  items: Partial<LocalStorageShape> | Record<string, unknown>,
): Promise<Result<void>> {
  return write(chrome.storage.local, items);
}

export function removeLocal(keys: string | string[]): Promise<Result<void>> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => {
      const lastError = chrome.runtime.lastError;
      resolve(lastError ? err(flowError('STORAGE_WRITE', lastError.message)) : ok());
    });
  });
}

export function getSync<T extends Partial<SyncStorageShape>>(defaults: T): Promise<Result<T>> {
  return read(chrome.storage.sync, null).then((result) => {
    if (!result.ok) return result;
    return ok({ ...defaults, ...(result.value as Partial<T>) });
  });
}

export function setSync(items: Partial<SyncStorageShape>): Promise<Result<void>> {
  return write(chrome.storage.sync, items);
}

/** Bytes currently used by the local area, across every key. */
export function bytesInUse(): Promise<number> {
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      // A failure here only costs us the budget guard, so fall back to "unknown
      // usage is zero" rather than blocking the capture.
      resolve(chrome.runtime.lastError ? 0 : bytes);
    });
  });
}
