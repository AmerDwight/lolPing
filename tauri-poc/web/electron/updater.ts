// electron-updater for the bundle: index.ts makes no updater in a portable build, so only the names are needed.
import { EventEmitter } from '../node/events';

class Updater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  checkForUpdates(): Promise<null> {
    return Promise.resolve(null);
  }
  downloadUpdate(): Promise<string[]> {
    return Promise.reject(new Error('updates are not part of lolPing on Tauri yet'));
  }
  quitAndInstall(): void {}
}

export const autoUpdater = new Updater();

export class CancellationToken {
  cancel(): void {}
}
