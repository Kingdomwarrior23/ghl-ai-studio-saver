// FreeMyGHL — preview.js
// Renders a captured project (chrome.storage.local key __fmghl_preview_data,
// written by popup.js's livePreview()) in a sandboxed iframe, with
// cross-origin assets rewritten to blob: URLs fetched via background.js's
// fetchBinary message (bypasses CORS/CSP the same way downloadZip() does).
//
// Data shapes consumed here (verified against the real producers, not assumed):
//   - background.js "fetchBinary" -> { success, base64, mime } (background.js:25-41)
//   - shared-asset-collector.js collectPageAssets() -> images:[{src,...}],
//     stylesheets:[{url,content,type}] (shared-asset-collector.js:5-97)
//   - projectData._multiPage -> [{route, slug, html, title}], produced by
//     crawler.js's fmghlCrawl() (crawler.js:189) and crawlLegacyPages() in
//     popup.js (popup.js:289). Single-page captures don't set _multiPage,
//     so we fall back to a synthetic single-page array below.
(async function () {
  const { __fmghl_preview_data: data } = await chrome.storage.local.get(["__fmghl_preview_data"]);
  if (!data) {
    document.body.innerHTML = "<p style='font-family:sans-serif;padding:2rem'>No captured project found. Grab a project first.</p>";
    return;
  }

  const pages = data._multiPage && data._multiPage.length > 0
    ? data._multiPage
    : [{ route: "/", slug: "index", html: data.fullHtml, title: data.pageTitle }];

  // Build blob URLs for every asset once, keyed by original URL, so all pages
  // can share them without re-fetching per page.
  async function assetToBlobUrl(url) {
    const resp = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: "fetchBinary", url, referer: data.pageUrl || "" }, r => resolve(r))
    );
    if (!resp?.success) return url; // fall back to original (may 404 in preview, acceptable)
    const bytes = Uint8Array.from(atob(resp.base64), c => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: resp.mime }));
  }

  const allAssetUrls = new Set();
  (data.images || []).forEach(i => i.src && i.src.startsWith("http") && allAssetUrls.add(i.src));
  (data.stylesheets || []).forEach(s => s.url && allAssetUrls.add(s.url));
  const urlToBlob = {};
  await Promise.all([...allAssetUrls].map(async url => { urlToBlob[url] = await assetToBlobUrl(url); }));

  function rewriteHtml(html) {
    let out = html || "";
    // Sort by original URL length, descending, before substituting. If one
    // asset URL is a strict substring/prefix of another (e.g. ".../logo.png"
    // vs ".../logo.png?v=2"), replacing the shorter one first would corrupt
    // the longer one's occurrence (leaves a broken concatenation like
    // "<blob-url>?v=2"). Longer/more-specific URLs must be replaced first.
    const entries = Object.entries(urlToBlob).sort((a, b) => b[0].length - a[0].length);
    for (const [orig, blob] of entries) {
      out = out.split(orig).join(blob);
    }
    return out;
  }

  // Release blob URLs when the tab unloads instead of leaking them for the
  // tab's entire lifetime with no cleanup path.
  window.addEventListener("beforeunload", () => {
    Object.values(urlToBlob).forEach(url => {
      try { URL.revokeObjectURL(url); } catch {}
    });
  });

  const select = document.getElementById("pageSelect");
  const frame = document.getElementById("previewFrame");
  pages.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = p.route || p.slug || `page ${i + 1}`;
    select.appendChild(opt);
  });
  function showPage(i) {
    frame.srcdoc = rewriteHtml(pages[i].html);
  }
  select.addEventListener("change", () => showPage(select.value));
  showPage(0);
})();
