import { BackgroundRequest, BackgroundResponse } from './shared/types';
import { SYNC_PREFIX } from './shared/sync';
import {
  hasIdentityWebAuthFlow,
  hasStorageSync,
  identityGetRedirectURL,
  identityLaunchWebAuthFlow,
  storageLocalGet,
  storageLocalRemove,
  storageLocalSet,
  storageSyncGet,
  storageSyncRemove,
  storageSyncSet,
  webext
} from './shared/webext';
import { GoogleDriveSyncClient } from './background/googleDriveSync';
import { createBackgroundService } from './background/service';

const localArea = {
  get: storageLocalGet,
  set: storageLocalSet,
  remove: storageLocalRemove
};

const driveClient = hasIdentityWebAuthFlow()
  ? new GoogleDriveSyncClient({
      local: localArea,
      identity: {
        getRedirectURL: identityGetRedirectURL,
        launchWebAuthFlow: identityLaunchWebAuthFlow
      }
    })
  : null;

const service = createBackgroundService({
  local: localArea,
  sync: hasStorageSync()
    ? {
        get: storageSyncGet,
        set: storageSyncSet,
        remove: storageSyncRemove
      }
    : null,
  drive: driveClient
});

// MV3 Service Worker 必须在顶层同步注册事件监听器，防止休眠唤醒时丢失事件。
webext.runtime.onMessage.addListener((
  message: BackgroundRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundResponse) => void
) => {
  service.handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

webext.storage?.onChanged?.addListener((
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
) => {
  if (areaName !== 'sync') return;
  if (!Object.keys(changes).some((key) => key.startsWith(SYNC_PREFIX))) return;
  void service.handleSyncChanged(changes);
});

webext.runtime?.onStartup?.addListener(() => {
  void service.initialize();
});

webext.runtime?.onInstalled?.addListener(() => {
  void service.initialize();
});
