// The core page: the Electron app's main process, src/main/index.ts, as it is. boot.ts first, for Node's globals;
// build-web.mjs points Electron and Node's modules at the stand-ins in electron/ and node/.
import './boot';
import { invoke } from './tauri';
import '../../src/main/index';

// Everything the shell held back for this page (window events, helper output) can come now.
invoke('core_ready').catch(() => undefined);
