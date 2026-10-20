// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the SSDP search through Gladys, plus the typed description URLs.
  gladys.onScanRequest(async () => {
    await app.scan();
  });
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands. A failure is logged here: the SDK only acks it to Gladys.
  gladys.onSetValue(async (device, feature, value) => {
    try {
      await app.setValue(device, feature, value);
    } catch (err) {
      logger?.error(`Command ${feature?.external_id} failed: ${err.message}`);
      throw err;
    }
  });

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.CHECK, () => app.checkDevices());
  gladys.onAction(ACTIONS.LIST, () => app.listSources());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.start(config));

  // Connection lifecycle (also after every reconnection to Gladys): the status
  // and the Discovery list are published again, since the core forgets them.
  gladys.on('connected', async () => {
    try {
      await app.start(await gladys.getConfig(), { connected: true });
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
