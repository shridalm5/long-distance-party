/**
 * Bridge script — runs in the content script isolated world.
 * Reads server URL from chrome.storage, stores it for content.js.
 * No script injection needed — everything runs in isolated world.
 */

(async function () {
  const result = await chrome.storage.local.get(["serverUrl"]);
  window.__LDP_SERVER_URL__ = result.serverUrl || "http://localhost:3000";
})();
