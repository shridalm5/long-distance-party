// Load saved server URL
chrome.storage.local.get(["serverUrl"], (result) => {
  if (result.serverUrl) {
    document.getElementById("server-url").value = result.serverUrl;
  }
});

// Save server URL
document.getElementById("save-btn").addEventListener("click", () => {
  const url = document.getElementById("server-url").value.trim();
  if (!url) return;

  chrome.storage.local.set({ serverUrl: url }, () => {
    const status = document.getElementById("status");
    status.style.display = "block";
    setTimeout(() => (status.style.display = "none"), 2000);
  });
});
