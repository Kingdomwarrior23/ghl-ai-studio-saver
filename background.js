// GHL Project Saver — background.js
// Service worker for handling downloads and cross-origin requests

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "downloadBlob") {
    // Convert base64 to blob and trigger download
    const blob = base64toBlob(msg.data, msg.mimeType);
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: msg.filename, saveAs: msg.saveAs || false }, () => {
      URL.revokeObjectURL(url);
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.action === "fetchUrl") {
    // Fetch external resources (CSS, JS) that content script can't access due to CORS
    fetch(msg.url)
      .then((r) => r.text())
      .then((text) => sendResponse({ success: true, content: text }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
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
