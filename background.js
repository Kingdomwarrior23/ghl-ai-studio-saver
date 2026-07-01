// FreeMyGHL — background.js
// Service worker: cross-origin fetches, downloads, auto-backup alarms

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "downloadBlob") {
    const blob = base64toBlob(msg.data, msg.mimeType);
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: msg.filename, saveAs: msg.saveAs || false }, () => {
      URL.revokeObjectURL(url);
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.action === "fetchUrl") {
    const headers = {};
    if (msg.referer) headers["Referer"] = msg.referer;
    fetch(msg.url, { headers })
      .then(r => r.text())
      .then(text => sendResponse({ success: true, content: text }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === "fetchBinary") {
    const headers = {};
    if (msg.referer) headers["Referer"] = msg.referer;
    fetch(msg.url, { headers })
      .then(r => {
        const mime = r.headers.get("content-type") || "application/octet-stream";
        return r.arrayBuffer().then(buf => ({ buf, mime }));
      })
      .then(({ buf, mime }) => {
        const bytes = new Uint8Array(buf);
        let binary = "";
        bytes.forEach(b => binary += String.fromCharCode(b));
        sendResponse({ success: true, base64: btoa(binary), mime });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === "setAlarm") {
    chrome.alarms.clear("auto-backup", () => {
      if (msg.hours > 0) {
        chrome.alarms.create("auto-backup", { periodInMinutes: msg.hours * 60 });
      }
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.action === "clearAlarm") {
    chrome.alarms.clear("auto-backup", () => sendResponse({ success: true }));
    return true;
  }
});

// ── Auto-backup alarm handler ─────────────────────────────
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "auto-backup") return;

  const tabs = await chrome.tabs.query({
    url: ["*://*.gohighlevel.com/*", "*://*.leadconnectorhq.com/*"],
  });
  if (tabs.length === 0) return;

  const tab = tabs[0];
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const resp = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 15000);
      chrome.tabs.sendMessage(tab.id, { action: "grabProject" }, r => {
        clearTimeout(timer);
        resolve(chrome.runtime.lastError ? null : r);
      });
    });

    if (!resp?.success) return;

    const snap = {
      id: Date.now(),
      url: tab.url,
      title: tab.title || "Untitled",
      grabbedAt: new Date().toISOString(),
      auto: true,
      htmlLength: resp.data.fullHtml?.length || 0,
      html: (resp.data.fullHtml || "").substring(0, 400000),
      counts: {
        css: resp.data.cssCount || 0,
        js: resp.data.jsCount || 0,
        images: resp.data.imageCount || 0,
        schemas: resp.data.schemaCount || 0,
      },
    };

    const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
    snapshots.unshift(snap);
    if (snapshots.length > 25) snapshots.splice(25);
    await chrome.storage.local.set({ snapshots });
  } catch (e) {
    console.log("[FreeMyGHL] Auto-backup failed:", e.message);
  }
});

function base64toBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteArrays = [];
  for (let i = 0; i < byteChars.length; i += 512) {
    const slice = byteChars.slice(i, i + 512);
    const byteNums = new Array(slice.length);
    for (let j = 0; j < slice.length; j++) byteNums[j] = slice.charCodeAt(j);
    byteArrays.push(new Uint8Array(byteNums));
  }
  return new Blob(byteArrays, { type: mimeType });
}
