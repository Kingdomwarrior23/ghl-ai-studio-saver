// GHL Project Saver — popup.js
// Main orchestrator: injects content script, collects data, packages ZIP

let projectData = null;

// ── Utility ──────────────────────────────────────────────
function setStatus(text, type) {
  const el = document.getElementById("status");
  el.className = "status-bar " + type;
  document.getElementById("currentUrl").textContent = text;
}

function setProgress(pct) {
  const wrap = document.getElementById("progress");
  const bar = document.getElementById("progressBar");
  wrap.classList.add("show");
  bar.style.width = pct + "%";
  if (pct >= 100) setTimeout(() => wrap.classList.remove("show"), 800);
}

function showResults(data) {
  const el = document.getElementById("results");
  const list = document.getElementById("resultsList");
  el.classList.add("show");
  const frameSrc = projectData.frameSource || "main";
  const frameLabel = frameSrc === "main" ? "top page" : frameSrc;
  const items = [
    ["Content source", frameLabel],
    ["HTML files", data.htmlCount || 1],
    ["CSS stylesheets", data.cssCount || 0],
    ["JS scripts", data.jsCount || 0],
    ["Images", data.imageCount || 0],
    ["Fonts", data.fontCount || 0],
    ["JSON-LD schemas", data.schemaCount || 0],
    ["Meta tags", data.metaCount || 0],
    ["OG tags", data.ogCount || 0],
    ["Total assets", data.totalAssets || 0],
  ];
  list.innerHTML = items
    .map(([label, count]) =>
      `<div class="item"><span class="label">${label}</span><span class="count">${count}</span></div>`
    )
    .join("");
}

function showSchemas(schemas) {
  const wrap = document.getElementById("schemasPreview");
  const list = document.getElementById("schemasList");
  if (!schemas || schemas.length === 0) {
    wrap.classList.add("show");
    list.innerHTML =
      '<div style="color:#f44336;font-size:12px;padding:8px;">❌ No JSON-LD schemas found on this page</div>';
    return;
  }
  wrap.classList.add("show");
  list.innerHTML = schemas
    .map(
      (s, i) =>
        `<div class="schema-item" data-idx="${i}" title="Click to copy">
          <span class="type">@${s.type}</span><br>
          ${s.preview}
        </div>`
    )
    .join("");
  // Click to copy
  list.querySelectorAll(".schema-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx);
      navigator.clipboard.writeText(JSON.stringify(schemas[idx].raw, null, 2));
      el.style.borderColor = "#4caf50";
      setTimeout(() => (el.style.borderColor = "#333"), 1000);
    });
  });
}

// ── Parse raw HTML string into the same data shape as content.js ─────────
function parseHtmlToData(html, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Resolve relative URLs against the page's base
  const base = new URL(baseUrl);
  function abs(url) {
    try { return new URL(url, base).href; } catch { return url; }
  }

  const data = {};
  data.frameSource = "direct-fetch (" + base.hostname + ")";
  data.isIframe = false;
  data.hostname = base.hostname;
  data.frameUrl = baseUrl;
  data.fullHtml = html;
  data.pageTitle = doc.title || "";
  data.htmlCount = 1;

  // contentScore: mark as high so it wins over any future builder shell
  data.contentScore = html.length / 1000;

  // Schemas
  data.schemas = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const raw = JSON.parse(s.textContent);
      if (raw["@graph"]) {
        raw["@graph"].forEach(item => {
          const type = item["@type"] || "GraphItem";
          const preview = Object.keys(item).slice(0, 5).map(k => `${k}: ${String(item[k]).substring(0, 40)}`).join(", ");
          data.schemas.push({ type, raw: item, preview });
        });
      } else {
        const type = raw["@type"] || "Unknown";
        const preview = Object.keys(raw).slice(0, 5).map(k => `${k}: ${String(raw[k]).substring(0, 40)}`).join(", ");
        data.schemas.push({ type, raw, preview });
      }
    } catch { data.schemas.push({ type: "MALFORMED", raw: s.textContent, preview: s.textContent.substring(0, 80) }); }
  });
  data.schemaCount = data.schemas.length;

  // Meta tags
  data.metaTags = { meta: [], og: [], twitter: [], other: [] };
  doc.querySelectorAll("meta").forEach(m => {
    const obj = {};
    for (const attr of m.attributes) obj[attr.name] = attr.value;
    const name = m.getAttribute("name") || m.getAttribute("property") || "";
    if (name.startsWith("og:")) data.metaTags.og.push(obj);
    else if (name.startsWith("twitter:")) data.metaTags.twitter.push(obj);
    else if (name) data.metaTags.meta.push(obj);
    else data.metaTags.other.push(obj);
  });
  data.metaCount = data.metaTags.meta.length;
  data.ogCount = data.metaTags.og.length;
  const canonical = doc.querySelector('link[rel="canonical"]');
  data.metaTags.canonical = canonical ? abs(canonical.getAttribute("href")) : null;

  // Stylesheets
  data.stylesheets = [];
  doc.querySelectorAll("style").forEach(s => {
    if (s.textContent.trim()) data.stylesheets.push({ url: null, content: s.textContent, type: "inline" });
  });
  doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const href = abs(link.getAttribute("href") || "");
    if (href && !data.stylesheets.some(s => s.url === href)) {
      data.stylesheets.push({ url: href, content: null, type: "external-url" });
    }
  });
  data.cssCount = data.stylesheets.length;

  // Scripts
  data.scripts = [];
  doc.querySelectorAll("script").forEach(s => {
    if (s.type === "application/ld+json") return;
    if (s.getAttribute("src")) {
      const src = abs(s.getAttribute("src"));
      if (!data.scripts.some(x => x.url === src)) data.scripts.push({ url: src, content: null, type: "external" });
    } else if (s.textContent.trim()) {
      data.scripts.push({ url: null, content: s.textContent, type: "inline" });
    }
  });
  data.jsCount = data.scripts.length;

  // Images
  data.images = [];
  const seenSrcs = new Set();
  doc.querySelectorAll("img").forEach(img => {
    const src = abs(img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "");
    if (src && !seenSrcs.has(src)) {
      seenSrcs.add(src);
      data.images.push({ src, alt: img.alt || "", width: null, height: null, loading: img.loading || "eager" });
    }
  });
  data.imageCount = data.images.length;

  // Fonts
  data.fonts = [];
  doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const href = link.getAttribute("href") || "";
    if (href.includes("fonts.googleapis") || href.includes("font")) {
      data.fonts.push({ url: abs(href), type: "google-fonts" });
    }
  });
  data.fontCount = data.fonts.length;

  // GHL structure
  data.ghlStructure = [];
  doc.querySelectorAll('[class*="section"],[class*="cblock"],[id*="section"],[class*="el-"],[class*="gh-"],[class*="row"],[class*="column"],[class*="element"]').forEach(el => {
    data.ghlStructure.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.className?.toString() || "").substring(0, 200),
      childCount: el.children.length,
      textPreview: (el.textContent?.trim() || "").substring(0, 100),
    });
  });

  // Links
  data.links = [];
  doc.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (href && !href.startsWith("javascript:")) {
      data.links.push({ href: abs(href), text: a.textContent.trim().substring(0, 100), target: a.target || "" });
    }
  });

  data.totalAssets = data.cssCount + data.jsCount + data.imageCount + data.fontCount + data.schemaCount + data.links.length;
  return data;
}

// ── Inject content script and extract ────────────────────
async function grabProject() {
  const btn = document.getElementById("btnGrab");
  btn.disabled = true;
  btn.textContent = "⏳ Grabbing...";
  setStatus("Extracting page data...", "grabbing");
  setProgress(10);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // ── Find all frames on the page ─────────────────────
    // We need to inject into the GHL vibe iframe (cross-origin)
    setStatus("Finding all page frames...", "grabbing");
    let frames = [];
    try {
      frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: tab.id }, (f) => {
          resolve(chrome.runtime.lastError ? [] : (f || []));
        });
      });
    } catch { frames = []; }

    // Filter to frames we can actually inject into
    const injectable = frames.filter(f => f.url && !f.url.startsWith("chrome://") && !f.url.startsWith("chrome-extension://"));
    console.log(`[GHL Saver] Found ${injectable.length} injectable frames:`, injectable.map(f => f.url?.substring(0, 80)));

    setProgress(20);

    // ── Inject content script into each frame ───────────
    const allResponses = [];
    for (let i = 0; i < injectable.length; i++) {
      const frame = injectable[i];
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frame.frameId] },
          files: ["content.js"],
        });

        // Send grab message to this specific frame
        const resp = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(null), 8000);
          chrome.tabs.sendMessage(tab.id, { action: "grabProject" }, { frameId: frame.frameId }, (r) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve(null); // Frame didn't respond — skip it
            } else {
              resolve(r);
            }
          });
        });

        if (resp && resp.success) {
          resp.data._frameUrl = frame.url;
          resp.data._frameId = frame.frameId;
          allResponses.push(resp.data);
        }
      } catch (e) {
        console.log(`[GHL Saver] Frame ${frame.url?.substring(0, 60)} failed:`, e.message);
      }
      setProgress(20 + Math.round((i / injectable.length) * 50));
    }

    setProgress(70);

    if (allResponses.length === 0) {
      throw new Error("No frames responded. Try refreshing the page.");
    }

    // ── Pick the best response (highest content score) ──
    // Score: prefer iframes with actual page content over the Studio UI
    allResponses.sort((a, b) => (b.contentScore || 0) - (a.contentScore || 0));
    projectData = allResponses[0];
    projectData.pageUrl = tab.url;
    projectData.grabbedAt = new Date().toISOString();

    // Log all frames we found (for debugging)
    console.log(`[GHL Saver] Got ${allResponses.length} frame(s). Selected: ${projectData.frameSource} (score: ${projectData.contentScore})`);
    allResponses.forEach((r, i) => {
      console.log(`  Frame ${i}: ${r.frameSource} | score=${r.contentScore} | html=${r.fullHtml?.length} | assets=${r.totalAssets}`);
    });

    // ── Fallback: if best frame is still the builder shell, fetch preview URL directly ──
    // The Vibe preview iframe may be cross-origin and not injectable. We instead
    // find its src URL from the builder DOM, fetch the raw HTML via background.js
    // (which can bypass CORS), then parse it with DOMParser in the popup.
    if (projectData.contentScore < 0) {
      const withIframe = allResponses.find(r => r.previewIframeUrl);
      if (withIframe?.previewIframeUrl) {
        setStatus("Fetching site from preview frame...", "grabbing");
        console.log("[GHL Saver] Falling back to direct fetch:", withIframe.previewIframeUrl);
        const fetchResp = await new Promise(resolve =>
          chrome.runtime.sendMessage({ action: "fetchUrl", url: withIframe.previewIframeUrl }, r =>
            resolve(r || { success: false, error: "No response from background" })
          )
        );
        if (fetchResp?.success && fetchResp.content) {
          const parsed = parseHtmlToData(fetchResp.content, withIframe.previewIframeUrl);
          parsed.pageUrl = tab.url;
          parsed.grabbedAt = new Date().toISOString();
          projectData = parsed;
        } else {
          console.warn("[GHL Saver] Direct fetch failed:", fetchResp?.error);
        }
      } else {
        console.warn("[GHL Saver] Builder shell found but no preview iframe URL detected.");
      }
    }

    setProgress(90);
    showResults(projectData);
    showSchemas(projectData.schemas);

    document.getElementById("btnDownload").disabled = false;
    document.getElementById("btnSchemas").disabled = false;
    document.getElementById("btnGitHub").disabled = false;
    document.getElementById("btnNetlify").disabled = false;
    document.getElementById("btnVercel").disabled = false;
    document.getElementById("btnGHPages").disabled = false;
    document.getElementById("btnCloudflare").disabled = false;
    document.getElementById("btnSEOAudit").disabled = false;
    document.getElementById("btnBrandKit").disabled = false;
    document.getElementById("btnGDPR").disabled = false;
    document.getElementById("btnScrub").disabled = false;

    setStatus("Done! " + projectData.totalAssets + " assets captured", "done");
    saveSnapshot(projectData);
    setProgress(100);
  } catch (err) {
    setStatus("Error: " + err.message, "error");
    console.error("GHL Saver error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 Grab Full Project";
  }
}

// ── Resource fetch helpers (routed through background to bypass CORS) ────
function fetchText(url) {
  const referer = projectData?.pageUrl || projectData?.frameUrl || "";
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: "fetchUrl", url, referer }, r =>
      resolve(r?.success ? r.content : null)
    );
  });
}

function fetchBinary(url) {
  const referer = projectData?.pageUrl || projectData?.frameUrl || "";
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: "fetchBinary", url, referer }, r =>
      resolve(r?.success ? { base64: r.base64, mime: r.mime } : null)
    );
  });
}

function urlFilename(url, prefix, idx, ext) {
  try {
    const p = new URL(url).pathname;
    const name = p.split("/").pop().split("?")[0].replace(/[^a-zA-Z0-9._-]/g, "_");
    return name && name.includes(".") ? name : `${prefix}-${idx}${ext}`;
  } catch {
    return `${prefix}-${idx}${ext}`;
  }
}

function guessMime(url) {
  const u = url.toLowerCase().split("?")[0];
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".svg")) return "image/svg+xml";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".ico")) return "image/x-icon";
  if (u.endsWith(".woff2")) return "font/woff2";
  if (u.endsWith(".woff")) return "font/woff";
  if (u.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

// ── Shared bundle builder ─────────────────────────────────
// Returns { html, files } where files = [{path, content, binary, base64}]
// html has all external URLs rewritten to local relative paths.
// binary files have base64 content; text files have content string.
async function buildBundle(onStatus) {
  const log = onStatus || (() => {});
  let html = projectData.fullHtml || "";
  const files = [];
  const inlinedCssBlocks = []; // CSS text to inject directly into <head>

  // ── CSS: fetch every external stylesheet and inline it ───────────────
  // Inlining is more reliable than rewriting <link> hrefs — path issues
  // and CDN CORS mismatches can't break inline styles.
  log("Fetching CSS files...");
  const allStylesheets = (projectData.stylesheets || []);
  const externalCss = allStylesheets.filter(s => s.url && !s.url.startsWith("data:") && !s.url.includes("fonts.googleapis.com"));

  // Also scan HTML directly for any <link rel="stylesheet"> we might have missed
  const linkHrefMatches = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)]
    .map(m => m[1])
    .concat([...html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/gi)].map(m => m[1]));
  const missedUrls = linkHrefMatches.filter(u => u.startsWith("http") && !allStylesheets.some(s => s.url === u));
  const allExternalCss = [...externalCss, ...missedUrls.map(u => ({ url: u }))];

  await Promise.all(allExternalCss.map(async (s, i) => {
    const url = s.url;
    const name = urlFilename(url, "style", i, ".css");
    const content = await fetchText(url);
    if (content) {
      inlinedCssBlocks.push(`/* === ${url} === */\n${content}`);
      files.push({ path: `css/${name}`, content });
      // Also rewrite in html in case some JS checks the href
      html = html.split(url).join(`css/${name}`);
    }
  }));

  // ── Google Fonts: fetch CSS + download woff2 files, inline as data URIs ─
  log("Fetching Google Fonts...");
  const gFontLinks = allStylesheets.filter(s => s.url && s.url.includes("fonts.googleapis.com"));
  // Also catch google fonts links directly in HTML
  const gFontHtmlMatches = [...html.matchAll(/href=["'](https:\/\/fonts\.googleapis\.com[^"']+)["']/g)].map(m => m[1]);
  const allGFontUrls = [...new Set([...gFontLinks.map(s => s.url), ...gFontHtmlMatches])];

  for (let i = 0; i < allGFontUrls.length; i++) {
    const fontCssUrl = allGFontUrls[i];
    const fontCss = await fetchText(fontCssUrl);
    if (!fontCss) continue;
    // Download each woff2 and replace with data URI so font works offline
    const fontFileUrls = [...fontCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)].map(m => m[1]);
    let localFontCss = fontCss;
    await Promise.all(fontFileUrls.map(async fontUrl => {
      const result = await fetchBinary(fontUrl);
      if (result) {
        const dataUri = `data:${result.mime};base64,${result.base64}`;
        localFontCss = localFontCss.split(fontUrl).join(dataUri);
        files.push({ path: `fonts/${urlFilename(fontUrl, "gfont", 0, ".woff2")}`, binary: true, base64: result.base64 });
      }
    }));
    inlinedCssBlocks.push(`/* === Google Fonts: ${fontCssUrl} === */\n${localFontCss}`);
    files.push({ path: `css/google-fonts-${i}.css`, content: localFontCss });
    // Remove the <link> tag from HTML — we'll inject inline below
    html = html.replace(new RegExp(`<link[^>]*${fontCssUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`, "g"), "");
  }

  // ── Remove all external <link rel="stylesheet"> from HTML ─────────────
  // Replace with a single injected <style> block containing all fetched CSS.
  // This eliminates every path/CORS issue at once.
  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, "");
  html = html.replace(/<link[^>]+href=["'][^"']*\.css[^"']*["'][^>]*>/gi, "");

  if (inlinedCssBlocks.length > 0) {
    const styleTag = `<style id="ghl-saver-styles">\n${inlinedCssBlocks.join("\n\n")}\n</style>`;
    // Inject before </head>, or at top of <body> if no </head>
    if (html.includes("</head>")) {
      html = html.replace("</head>", `${styleTag}\n</head>`);
    } else {
      html = styleTag + "\n" + html;
    }
  }

  // ── JS: inline all scripts so they execute on static hosts ──────────
  // Replacing <script src="..."> with inline <script>...</script> means
  // GH Pages / Netlify / Vercel don't need to fetch JS from the original CDN.
  log("Fetching JS files...");
  const externalJs = (projectData.scripts || []).filter(s => s.url && !s.url.startsWith("data:"));
  // Also catch any <script src="..."> we might have missed
  const scriptSrcMatches = [...html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
  const missedJsUrls = scriptSrcMatches.filter(u => !externalJs.some(s => s.url === u));
  const allExternalJs = [...externalJs, ...missedJsUrls.map(u => ({ url: u }))];

  await Promise.all(allExternalJs.map(async s => {
    const content = await fetchText(s.url);
    if (content) {
      // Replace <script src="url"> with inline <script>content</script>
      const escapedUrl = s.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(
        new RegExp(`<script([^>]*)src=["']${escapedUrl}["']([^>]*)>\\s*</script>`, "gi"),
        `<script$1$2>\n${content}\n</script>`
      );
      const name = urlFilename(s.url, "script", 0, ".js");
      files.push({ path: `js/${name}`, content });
    }
  }));

  // ── Images: fetch all, convert to data URIs ───────────────────────
  log("Fetching images...");
  // Collect URLs from img src, srcset, and any remaining http:// in HTML
  const imgSrcSet = new Set();
  (projectData.images || [])
    .filter(img => img.src && !img.src.startsWith("data:") && !img.src.startsWith("svg-"))
    .forEach(img => imgSrcSet.add(img.src));
  // Also catch srcset URLs
  [...html.matchAll(/srcset=["']([^"']+)["']/gi)].forEach(m => {
    m[1].split(",").forEach(part => {
      const u = part.trim().split(/\s+/)[0];
      if (u.startsWith("http")) imgSrcSet.add(u);
    });
  });
  // Catch any remaining http image URLs in HTML attributes
  [...html.matchAll(/(?:src|href|data-src|data-bg|content)=["'](https?:\/\/[^"']+\.(?:png|jpg|jpeg|gif|webp|svg|ico|avif)[^"']*)["']/gi)]
    .forEach(m => imgSrcSet.add(m[1]));

  const imageUrlsArr = [...imgSrcSet];
  await Promise.all(imageUrlsArr.map(async (src, i) => {
    const result = await fetchBinary(src);
    if (result) {
      const dataUri = `data:${result.mime};base64,${result.base64}`;
      html = html.split(src).join(dataUri);
      // Also rewrite in any already-injected <style> block
      const ext = "." + result.mime.split("/")[1].replace("jpeg","jpg").replace("svg+xml","svg").replace("x-icon","ico");
      files.push({ path: `images/${urlFilename(src, "image", i, ext)}`, binary: true, base64: result.base64 });
    }
  }));

  // ── Rewrite ALL remaining http URLs in HTML ───────────────────────
  // Covers: CSS url(), inline style="background-image:url(...)",
  // CSS @import, favicon, og:image, video poster, any missed asset.
  log("Rewriting remaining asset URLs...");

  // 1. CSS url() references (background-image, mask, border-image, etc.)
  const cssUrlMatches = [...html.matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g)].map(m => m[1]);

  // 2. Inline style attributes with background/image URLs
  const inlineStyleMatches = [...html.matchAll(/style=["'][^"']*url\(["']?(https?:\/\/[^"')]+)["']?\)[^"']*["']/gi)]
    .flatMap(m => [...m[0].matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g)].map(n => n[1]));

  // 3. Favicon
  const faviconMatches = [...html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);

  // 4. Video poster images
  const videoPosterMatches = [...html.matchAll(/poster=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);

  // 5. CSS @import inside already-fetched CSS
  const cssImportMatches = [...html.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"');\s]+)["']?\)?/gi)].map(m => m[1]);

  const allAssetUrls = [...new Set([
    ...cssUrlMatches,
    ...inlineStyleMatches,
    ...faviconMatches,
    ...videoPosterMatches,
    ...cssImportMatches,
  ])].filter(u => u && !u.startsWith("data:"));

  await Promise.all(allAssetUrls.map(async assetUrl => {
    const result = await fetchBinary(assetUrl);
    if (result) {
      const dataUri = `data:${result.mime};base64,${result.base64}`;
      html = html.split(assetUrl).join(dataUri);
    } else {
      // Binary failed — try as text (SVGs, some CSS assets)
      const text = await fetchText(assetUrl);
      if (text) {
        const mime = assetUrl.endsWith(".svg") ? "image/svg+xml" : "text/plain";
        const dataUri = `data:${mime};base64,${btoa(unescape(encodeURIComponent(text)))}`;
        html = html.split(assetUrl).join(dataUri);
      }
    }
  }));

  // ── CSS @import: follow and inline ───────────────────────────────
  // @import inside fetched CSS pulls in another stylesheet — inline it too.
  const importMatches = [...html.matchAll(/@import\s+(?:url\()?["']?(https?:\/\/[^"');\s]+)["']?\)?[^;]*;/gi)];
  await Promise.all(importMatches.map(async match => {
    const importUrl = match[1];
    const importedCss = await fetchText(importUrl);
    if (importedCss) {
      html = html.replace(match[0], `/* @import inlined from ${importUrl} */\n${importedCss}`);
    }
  }));

  // ── Inject a "force-visible" style override at the end of <head> ──
  // Ensures any GHL animation/hide classes don't blank out sections.
  const forceVisibleStyle = `<style id="ghl-saver-force-visible">
*[style*="display: none"]{display:block!important}
*[style*="opacity: 0"]{opacity:1!important}
*[style*="visibility: hidden"]{visibility:visible!important}
[data-aos]{opacity:1!important;transform:none!important}
[class*="aos-animate"]{opacity:1!important;transform:none!important}
[class*="is-hidden"]{display:block!important;opacity:1!important}
[class*="hidden"]:not(input[type="hidden"]){opacity:1!important}
</style>`;
  if (html.includes("</head>")) {
    html = html.replace("</head>", `${forceVisibleStyle}\n</head>`);
  } else {
    html += forceVisibleStyle;
  }

  // Meta / schemas
  files.push({ path: "meta.json", content: JSON.stringify(projectData.metaTags, null, 2) });
  if (projectData.schemas) {
    projectData.schemas.forEach((s, i) => {
      files.push({ path: `schemas/schema-${i+1}-${s.type.toLowerCase()}.json`, content: JSON.stringify(s.raw, null, 2) });
    });
  }
  if (projectData.ghlStructure && projectData.ghlStructure.length > 0) {
    files.push({ path: "ghl-structure.json", content: JSON.stringify(projectData.ghlStructure, null, 2) });
  }
  files.push({ path: "manifest.json", content: JSON.stringify({
    url: projectData.pageUrl, grabbedAt: projectData.grabbedAt, title: projectData.pageTitle,
    cssFiles: externalCss.length, jsFiles: externalJs.length, imageFiles: imageUrlsArr.length,
  }, null, 2) });

  return { html, files };
}

// ── Build and download ZIP ───────────────────────────────
async function downloadZip() {
  if (!projectData) return;
  const btn = document.getElementById("btnDownload");
  btn.disabled = true;
  btn.textContent = "⏳ Building ZIP...";

  try {
    const zip = new JSZip();
    const root = zip.folder("ghl-project");
    let html = projectData.fullHtml || "";

    // ── Fetch external CSS ───────────────────────────────
    setStatus("Fetching CSS files...", "grabbing");
    setProgress(5);
    const cssDir = root.folder("css");
    const cssUrlMap = {}; // original url → local path

    const externalCss = (projectData.stylesheets || []).filter(s => s.url && !s.url.startsWith("data:"));
    const inlineCss = (projectData.stylesheets || []).filter(s => !s.url && s.content);

    inlineCss.forEach((s, i) => cssDir.file(`inline-${i}.css`, s.content));

    await Promise.all(externalCss.map(async (s, i) => {
      const name = urlFilename(s.url, "style", i, ".css");
      const content = await fetchText(s.url);
      cssDir.file(name, content || `/* could not fetch: ${s.url} */`);
      cssUrlMap[s.url] = `css/${name}`;
    }));

    setProgress(20);

    // ── Fetch external JS ────────────────────────────────
    setStatus("Fetching JS files...", "grabbing");
    const jsDir = root.folder("js");
    const jsUrlMap = {};

    const externalJs = (projectData.scripts || []).filter(s => s.url && !s.url.startsWith("data:"));
    const inlineJs = (projectData.scripts || []).filter(s => !s.url && s.content);

    inlineJs.forEach((s, i) => jsDir.file(`inline-${i}.js`, s.content));

    await Promise.all(externalJs.map(async (s, i) => {
      const name = urlFilename(s.url, "script", i, ".js");
      const content = await fetchText(s.url);
      jsDir.file(name, content || `/* could not fetch: ${s.url} */`);
      jsUrlMap[s.url] = `js/${name}`;
    }));

    setProgress(40);

    // ── Fetch images ─────────────────────────────────────
    setStatus("Fetching images...", "grabbing");
    const imgDir = root.folder("images");
    const imgUrlMap = {};

    const imageUrls = (projectData.images || [])
      .filter(img => img.src && !img.src.startsWith("data:") && !img.src.startsWith("svg-"));

    await Promise.all(imageUrls.map(async (img, i) => {
      const name = urlFilename(img.src, "image", i, ".img");
      const result = await fetchBinary(img.src);
      if (result) {
        const ext = "." + (result.mime || guessMime(img.src)).split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg").replace("x-icon", "ico");
        const finalName = name.includes(".") ? name : name + ext;
        imgDir.file(finalName, result.base64, { base64: true });
        imgUrlMap[img.src] = `images/${finalName}`;
      }
    }));

    setProgress(65);

    // ── Rewrite HTML to use local paths ──────────────────
    setStatus("Building self-contained HTML...", "grabbing");

    // Replace external stylesheet links with local refs
    Object.entries(cssUrlMap).forEach(([orig, local]) => {
      html = html.split(orig).join(local);
    });

    // Replace external script srcs with local refs
    Object.entries(jsUrlMap).forEach(([orig, local]) => {
      html = html.split(orig).join(local);
    });

    // Replace image srcs with local refs
    Object.entries(imgUrlMap).forEach(([orig, local]) => {
      html = html.split(orig).join(local);
    });

    root.file("index.html", html);

    setProgress(75);

    // ── Schemas ──────────────────────────────────────────
    if (projectData.schemas && projectData.schemas.length) {
      const schemaDir = root.folder("schemas");
      projectData.schemas.forEach((s, i) => {
        schemaDir.file(`schema-${i + 1}-${s.type.toLowerCase()}.json`, JSON.stringify(s.raw, null, 2));
      });
      const combined = projectData.schemas
        .map(s => `<script type="application/ld+json">\n${JSON.stringify(s.raw, null, 2)}\n</script>`)
        .join("\n\n");
      schemaDir.file("ALL-SCHEMAS-PASTE.txt", combined);
    }

    // ── Fonts ────────────────────────────────────────────
    if (projectData.fonts && projectData.fonts.length) {
      const fontDir = root.folder("fonts");
      const cssDir2 = root.folder("css");

      // Self-hosted fonts
      await Promise.all(
        projectData.fonts
          .filter(f => f.url && !f.url.includes("fonts.googleapis"))
          .map(async (f, i) => {
            const name = urlFilename(f.url, "font", i, ".woff2");
            const result = await fetchBinary(f.url);
            if (result) {
              fontDir.file(name, result.base64, { base64: true });
              html = html.split(f.url).join(`fonts/${name}`);
            }
          })
      );

      // Google Fonts — fetch CSS, extract gstatic font URLs, download each
      const gFontLinks2 = projectData.fonts.filter(f => f.url && f.url.includes("fonts.googleapis"));
      for (let i = 0; i < gFontLinks2.length; i++) {
        const fontCss = await fetchText(gFontLinks2[i].url);
        if (!fontCss) continue;
        const fontFileUrls = [...fontCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)]
          .map(m => m[1]);
        let localFontCss = fontCss;
        await Promise.all(fontFileUrls.map(async (fontUrl, j) => {
          const name = urlFilename(fontUrl, `gfont-${i}`, j, ".woff2");
          const result = await fetchBinary(fontUrl);
          if (result) {
            fontDir.file(name, result.base64, { base64: true });
            localFontCss = localFontCss.split(fontUrl).join(`../fonts/${name}`);
          }
        }));
        const cssName = `google-fonts-${i}.css`;
        cssDir2.file(cssName, localFontCss);
        html = html.split(gFontLinks2[i].url).join(`css/${cssName}`);
      }

      // Re-save index.html with font paths rewritten
      root.file("index.html", html);
    }

    // ── Meta / manifest ──────────────────────────────────
    root.file("meta.json", JSON.stringify(projectData.metaTags, null, 2));
    root.file("manifest.json", JSON.stringify({
      url: projectData.pageUrl,
      grabbedAt: projectData.grabbedAt,
      title: projectData.pageTitle,
      cssFiles: Object.keys(cssUrlMap).length + inlineCss.length,
      jsFiles: Object.keys(jsUrlMap).length + inlineJs.length,
      imageFiles: Object.keys(imgUrlMap).length,
      schemaCount: (projectData.schemas || []).length,
    }, null, 2));

    if (projectData.ghlStructure && projectData.ghlStructure.length > 0) {
      root.file("ghl-structure.json", JSON.stringify(projectData.ghlStructure, null, 2));
    }

    root.file("README.md",
`# GHL Export — ${projectData.pageTitle || "Untitled"}
**Source:** ${projectData.pageUrl}
**Exported:** ${projectData.grabbedAt}

---

## How to use this export

### Option 1 — Open locally
Double-click \`index.html\`. Your browser will open the full page. Everything is self-contained — no internet required except for form submissions and video embeds.

### Option 2 — Deploy to Netlify (free, live URL in 60 seconds)
1. Go to app.netlify.com → "Add new site" → "Deploy manually"
2. Drag this entire folder onto the upload area
3. You'll get a live URL like \`your-site.netlify.app\`
4. Optional: connect a custom domain in Site Settings → Domain Management

### Option 3 — Deploy to Vercel
1. Install Vercel CLI: \`npm i -g vercel\`
2. Run \`vercel\` inside this folder
3. Follow the prompts — live in under a minute

### Option 4 — Deploy to GitHub Pages
1. Push this folder to a GitHub repo
2. Go to repo Settings → Pages → Source: main branch / root
3. Your site goes live at \`https://username.github.io/repo-name\`

### Option 5 — Upload to any web host (cPanel, FTP, etc.)
Upload all files keeping the folder structure intact. Point your domain to the folder. Done.

---

## What works out of the box
- Full layout, colors, fonts, images — pixel-perfect
- Contact forms — still submit directly to your GHL account (forms are embedded from GHL's servers, nothing changes)
- Video embeds (YouTube, Vimeo) — load normally
- All tracking scripts (Facebook Pixel, Google Analytics, etc.) — fire on page load

## What still needs GHL
- **Form processing** — your forms work, but the automation/workflow that fires after submission runs inside GHL. That's already handled — you don't need to do anything.
- **Live countdown timers** — if your page has a countdown tied to a GHL event, it's captured as static HTML. To make it live again, add a free countdown script like [countdownmail.com](https://countdownmail.com) and paste it in place of the timer section.
- **Member-gated content** — pages behind GHL memberships won't be accessible without GHL. No fix needed unless you're moving to a different membership platform.

---

## Files in this export
- \`index.html\` — Complete self-contained page (all CSS/JS/images inlined)
- \`css/\` — All stylesheets downloaded from source
- \`js/\` — All scripts downloaded from source
- \`images/\` — All images downloaded from source
- \`fonts/\` — All fonts (including Google Fonts converted to local files)
- \`schemas/\` — JSON-LD structured data
- \`meta.json\` — All meta, Open Graph, and Twitter Card tags
- \`manifest.json\` — Export metadata

## Schemas found
${(projectData.schemas || []).map(s => `- @${s.type}`).join("\n") || "None found"}

---
Exported with [Keep My GHL](https://ownmyghl.ignitiv.io) — Own your GHL work forever.
`);

    setProgress(90);
    setStatus("Compressing ZIP...", "grabbing");
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ghl-project-" + Date.now() + ".zip";
    a.click();
    URL.revokeObjectURL(url);

    setProgress(100);
    setStatus(`ZIP downloaded — ${Object.keys(cssUrlMap).length} CSS, ${Object.keys(jsUrlMap).length} JS, ${Object.keys(imgUrlMap).length} images`, "done");

  } catch (err) {
    setStatus("ZIP error: " + err.message, "error");
    console.error("GHL Saver ZIP error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Download ZIP";
  }
}

// ── Helpers ──────────────────────────────────────────────
// btoa(unescape(encodeURIComponent())) breaks on large or unicode-heavy HTML.
// TextEncoder → binary string → btoa is correct for all content.
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Repo Picker ──────────────────────────────────────────
async function fetchUserRepos(token) {
  const resp = await fetch(
    "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner",
    { headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } }
  );
  if (!resp.ok) throw new Error("Failed to fetch repos (" + resp.status + ")");
  return resp.json();
}

function showRepoPicker(token, repos, lastRepo) {
  const picker = document.getElementById("repoPicker");
  const listEl = document.getElementById("repoList");
  const searchEl = document.getElementById("repoSearch");

  function renderList(filter) {
    const q = (filter || "").toLowerCase();
    const filtered = repos.filter(r => !q || r.full_name.toLowerCase().includes(q));
    let html = "";

    // Last-used pinned at top (only when not filtering)
    if (!q && lastRepo) {
      html += `<div class="repo-item repo-item--last" data-repo="${lastRepo}">
        <span class="repo-name">${lastRepo}</span>
        <span class="repo-badge">last used</span>
      </div>`;
    }

    filtered.forEach(r => {
      if (!q && r.full_name === lastRepo) return; // already pinned
      html += `<div class="repo-item" data-repo="${r.full_name}">
        <span class="repo-name">${r.full_name}</span>
        <span class="repo-vis">${r.private ? "private" : "public"}</span>
      </div>`;
    });

    if (!html) html = '<div class="repo-empty">No repos found</div>';
    listEl.innerHTML = html;

    listEl.querySelectorAll(".repo-item").forEach(el => {
      el.addEventListener("click", () => {
        hidePicker();
        doPush(token, el.dataset.repo);
      });
    });
  }

  renderList("");
  searchEl.value = "";
  searchEl.addEventListener("input", () => renderList(searchEl.value));
  picker.classList.add("show");
  setTimeout(() => searchEl.focus(), 50);

  document.getElementById("btnCreateNewRepo").onclick = () => {
    const name = document.getElementById("newRepoName").value.trim();
    if (!name) { document.getElementById("newRepoName").focus(); return; }
    hidePicker();
    doPush(token, name); // doPush auto-creates if repo doesn't exist
  };

  document.getElementById("newRepoName").onkeydown = (e) => {
    if (e.key === "Enter") document.getElementById("btnCreateNewRepo").click();
  };

  document.getElementById("btnCancelPicker").onclick = hidePicker;
}

function hidePicker() {
  document.getElementById("repoPicker").classList.remove("show");
}

// ── GitHub Push ──────────────────────────────────────────
async function pushToGitHub() {
  if (!projectData) return;

  let { githubToken } = await chrome.storage.local.get(["githubToken"]);

  if (!githubToken) {
    githubToken = prompt("Enter your GitHub Personal Access Token:");
    if (!githubToken) return;
    await chrome.storage.local.set({ githubToken });
  }

  setStatus("Loading your repositories...", "grabbing");
  try {
    const [repos, { githubRepo: lastRepo }] = await Promise.all([
      fetchUserRepos(githubToken),
      chrome.storage.local.get(["githubRepo"]),
    ]);
    showRepoPicker(githubToken, repos, lastRepo || null);
    setStatus("Select a repo to push to", "ready");
  } catch (err) {
    setStatus("Error loading repos: " + err.message, "error");
  }
}

async function doPush(githubToken, repo) {
  if (!repo.includes("/")) {
    setStatus("Resolving username...", "grabbing");
    const userResp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${githubToken}`, Accept: "application/vnd.github.v3+json" },
    });
    if (userResp.ok) {
      const { login } = await userResp.json();
      repo = `${login}/${repo}`;
    }
  }

  await chrome.storage.local.set({ githubRepo: repo });

  const btn = document.getElementById("btnGitHub");
  btn.disabled = true;
  btn.textContent = "⏳ Pushing...";
  setProgress(5);

  const headers = {
    Authorization: `token ${githubToken}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github.v3+json",
  };

  try {
    setStatus("Fetching all assets...", "grabbing");
    const { html, files: bundleFiles } = await buildBundle(msg => setStatus(msg, "grabbing"));
    const files = [{ path: "index.html", content: html }, ...bundleFiles];

    setProgress(10);

    // ── Ensure repo exists; auto-create with auto_init if needed ────
    let repoResp = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoResp.ok && repoResp.status === 404) {
      setStatus("Creating repo on GitHub...", "grabbing");
      const createResp = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: repo.split("/").pop(),
          description: `GHL Saver export — ${projectData.pageTitle || repo}`,
          private: false,
          auto_init: true,
        }),
      });
      if (!createResp.ok) {
        const e = await createResp.json();
        throw new Error(`Could not create repo: ${e.message}`);
      }
      // Brief wait for GitHub to initialize the repo
      await new Promise(r => setTimeout(r, 1500));
      repoResp = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    } else if (!repoResp.ok) {
      const e = await repoResp.json();
      throw new Error(`GitHub error (${repoResp.status}): ${e.message}`);
    }

    setProgress(20);

    // ── Use Contents API — works on empty and non-empty repos ────────
    // GET existing file SHA first (needed for updates), then PUT.
    setStatus(`Pushing ${files.length} files...`, "grabbing");
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(`Pushing ${f.path} (${i + 1}/${files.length})...`, "grabbing");

      // Check if file already exists (need its SHA to update)
      let existingSha = null;
      const getResp = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}`, { headers });
      if (getResp.ok) {
        existingSha = (await getResp.json()).sha;
      }

      const fileContent = f.binary ? f.base64 : toBase64(f.content || "");
      const putBody = {
        message: existingSha
          ? `GHL Saver: update ${f.path}`
          : `GHL Saver: add ${f.path}`,
        content: fileContent,
        ...(existingSha && { sha: existingSha }),
      };

      const putResp = await fetch(`https://api.github.com/repos/${repo}/contents/${f.path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(putBody),
      });

      if (!putResp.ok) {
        const e = await putResp.json();
        throw new Error(`Failed to push ${f.path}: ${e.message}`);
      }

      setProgress(20 + Math.round(((i + 1) / files.length) * 75));
    }

    setProgress(100);
    setStatus(`Pushed ${files.length} files to ${repo}`, "done");
    const linkEl = document.getElementById("currentUrl");
    linkEl.innerHTML = `<a href="https://github.com/${repo}" target="_blank" style="color:#4caf50;text-decoration:underline;">✅ github.com/${repo}</a>`;

  } catch (err) {
    setStatus("GitHub error: " + err.message, "error");
    console.error("GHL Saver GitHub error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "🐙 Push to GitHub";
  }
}

// ── Preview Schemas Only (quick grab, no full project) ───
async function previewSchemas() {
  const btn = document.getElementById("btnSchemas");
  btn.disabled = true;
  btn.textContent = "⏳ Grabbing schemas...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Find all frames
    let frames = [];
    try {
      frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId: tab.id }, (f) => {
          resolve(chrome.runtime.lastError ? [] : (f || []));
        });
      });
    } catch { frames = []; }
    const injectable = frames.filter(f => f.url && !f.url.startsWith("chrome://") && !f.url.startsWith("chrome-extension://"));

    // Collect schemas from all frames
    let allSchemas = [];
    for (const frame of injectable) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frame.frameId] },
          files: ["content.js"],
        });
        const resp = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000);
          chrome.tabs.sendMessage(tab.id, { action: "grabProject" }, { frameId: frame.frameId }, (r) => {
            clearTimeout(timer);
            resolve(chrome.runtime.lastError ? null : r);
          });
        });
        if (resp?.success && resp.data.schemas?.length > 0) {
          allSchemas.push(...resp.data.schemas);
          // Store full data from best frame too
          if (!projectData || (resp.data.contentScore > (projectData.contentScore || 0))) {
            projectData = resp.data;
            projectData.pageUrl = tab.url;
            projectData.grabbedAt = new Date().toISOString();
            document.getElementById("btnDownload").disabled = false;
            document.getElementById("btnGitHub").disabled = false;
            document.getElementById("btnNetlify").disabled = false;
            document.getElementById("btnVercel").disabled = false;
            document.getElementById("btnGHPages").disabled = false;
            document.getElementById("btnCloudflare").disabled = false;
            document.getElementById("btnSEOAudit").disabled = false;
            document.getElementById("btnBrandKit").disabled = false;
            document.getElementById("btnGDPR").disabled = false;
            document.getElementById("btnScrub").disabled = false;
          }
        }
      } catch {}
    }

    showSchemas(allSchemas);
    setStatus(allSchemas.length + " schema(s) found", allSchemas.length > 0 ? "done" : "error");
  } catch (err) {
    setStatus("Schema error: " + err.message, "error");
    console.error("GHL Saver schema error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Preview Schemas Only";
  }
}

// ── Netlify Deploy ───────────────────────────────────────
async function deployToNetlify() {
  if (!projectData) return;
  const btn = document.getElementById("btnNetlify");
  btn.disabled = true;
  btn.textContent = "⏳ Deploying...";
  setProgress(5);

  try {
    let { netlifyToken } = await chrome.storage.local.get(["netlifyToken"]);
    if (!netlifyToken) {
      netlifyToken = prompt("Enter your Netlify Personal Access Token (app.netlify.com/user/applications/personal):");
      if (!netlifyToken) { btn.disabled = false; btn.textContent = "🚀 Netlify"; return; }
      await chrome.storage.local.set({ netlifyToken });
    }

    const headers = { Authorization: `Bearer ${netlifyToken}` };

    setStatus("Fetching all assets for Netlify...", "grabbing");
    setProgress(15);
    const { html, files: bundleFiles } = await buildBundle(msg => setStatus(msg, "grabbing"));

    const zip = new JSZip();
    zip.file("index.html", html);
    zip.file("_redirects", "/* /index.html 200\n");
    bundleFiles.forEach(f => {
      if (f.binary) zip.file(f.path, f.base64, { base64: true });
      else zip.file(f.path, f.content || "");
    });

    setProgress(30);
    setStatus("Packaging for Netlify...", "grabbing");
    const zipBlob = await zip.generateAsync({ type: "blob" });

    setProgress(50);
    setStatus("Creating Netlify site...", "grabbing");

    // Step 1 — create a new site
    const siteResp = await fetch("https://api.netlify.com/api/v1/sites", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `ghl-export-${Date.now()}` }),
    });

    if (!siteResp.ok) {
      const e = await siteResp.json();
      if (siteResp.status === 401 || siteResp.status === 403) {
        await chrome.storage.local.remove(["netlifyToken"]);
      }
      throw new Error(e.message || `Netlify error ${siteResp.status}`);
    }

    const site = await siteResp.json();
    setProgress(65);
    setStatus("Deploying ZIP to Netlify...", "grabbing");

    // Step 2 — deploy ZIP to the new site
    const deployResp = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: zipBlob,
    });

    if (!deployResp.ok) {
      const e = await deployResp.json();
      throw new Error(e.message || `Deploy error ${deployResp.status}`);
    }

    const deploy = await deployResp.json();
    setProgress(85);
    setStatus("Waiting for deploy to go live...", "grabbing");

    // Step 3 — poll until ready (max 30s)
    let siteUrl = site.ssl_url || site.url || `https://${site.subdomain}.netlify.app`;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const check = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}`, { headers });
      if (check.ok) {
        const d = await check.json();
        if (d.state === "ready") { siteUrl = d.ssl_url || siteUrl; break; }
        if (d.state === "error") throw new Error("Netlify build failed.");
      }
    }

    setProgress(100);
    setStatus("Live on Netlify! ✅", "done");
    const linkEl = document.getElementById("currentUrl");
    linkEl.innerHTML = `<a href="${siteUrl}" target="_blank" style="color:#00d9b1;text-decoration:underline;">🌐 ${siteUrl}</a>`;
    await chrome.storage.local.set({ lastNetlifySite: siteUrl });

  } catch (err) {
    setStatus("Netlify failed: " + err.message, "error");
    console.error("[Keep My GHL] Netlify error:", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 Netlify";
  }
}

// ── Vercel Deploy ────────────────────────────────────────
async function deployToVercel() {
  if (!projectData) return;
  const btn = document.getElementById("btnVercel");
  btn.disabled = true;
  btn.textContent = "⏳ Deploying...";
  setProgress(5);

  try {
    let { vercelToken } = await chrome.storage.local.get(["vercelToken"]);
    if (!vercelToken) {
      vercelToken = prompt("Enter your Vercel API token (vercel.com/account/tokens):");
      if (!vercelToken) { btn.disabled = false; btn.textContent = "▲ Vercel"; return; }
      await chrome.storage.local.set({ vercelToken });
    }

    setStatus("Fetching all assets for Vercel...", "grabbing");
    setProgress(15);
    const { html, files: bundleFiles } = await buildBundle(msg => setStatus(msg, "grabbing"));

    setProgress(50);
    setStatus("Uploading to Vercel...", "grabbing");

    const vercelFiles = [
      { file: "index.html", data: html },
      { file: "vercel.json", data: JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }) },
    ];
    bundleFiles.forEach(f => {
      if (!f.binary) vercelFiles.push({ file: f.path, data: f.content || "" });
      // Binary files: Vercel v13 accepts base64 with encoding field
      else vercelFiles.push({ file: f.path, data: f.base64, encoding: "base64" });
    });

    const deployResp = await fetch("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ghl-export",
        files: vercelFiles,
        projectSettings: { framework: null },
        target: "production",
      }),
    });

    setProgress(80);

    if (!deployResp.ok) {
      const err = await deployResp.json();
      // Token stored but invalid — clear it so next attempt re-prompts
      if (deployResp.status === 401 || deployResp.status === 403) {
        await chrome.storage.local.remove(["vercelToken"]);
      }
      throw new Error(err.error?.message || `Vercel error ${deployResp.status}`);
    }

    const deploy = await deployResp.json();
    // Poll until ready (Vercel deployments are async)
    let siteUrl = `https://${deploy.url}`;
    setProgress(90);
    setStatus("Waiting for deployment to go live...", "grabbing");

    // Simple poll — max 20s
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const check = await fetch(`https://api.vercel.com/v13/deployments/${deploy.id}`, {
        headers: { Authorization: `Bearer ${vercelToken}` },
      });
      if (check.ok) {
        const d = await check.json();
        if (d.readyState === "READY") { siteUrl = `https://${d.url}`; break; }
        if (d.readyState === "ERROR") throw new Error("Vercel build failed.");
      }
    }

    setProgress(100);
    setStatus("Live on Vercel! ✅", "done");
    const linkEl = document.getElementById("currentUrl");
    linkEl.innerHTML = `<a href="${siteUrl}" target="_blank" style="color:#e0e0e0;text-decoration:underline;">▲ ${siteUrl}</a>`;
    await chrome.storage.local.set({ lastVercelUrl: siteUrl });

  } catch (err) {
    setStatus("Vercel deploy failed: " + err.message, "error");
    console.error("[Keep My GHL] Vercel error:", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "▲ Vercel";
  }
}

// ── GitHub Pages ─────────────────────────────────────────
// Pushes to gh-pages branch then enables Pages via API.
// Reuses the stored GitHub token — no new credentials needed.
async function deployToGHPages() {
  if (!projectData) return;
  const btn = document.getElementById("btnGHPages");
  btn.disabled = true;
  btn.textContent = "⏳ Deploying...";
  setProgress(5);

  try {
    let { githubToken, githubRepo } = await chrome.storage.local.get(["githubToken", "githubRepo"]);

    if (!githubToken) {
      githubToken = prompt("Enter your GitHub Personal Access Token (needs repo + pages scope):");
      if (!githubToken) { btn.disabled = false; btn.textContent = "📄 GH Pages"; return; }
      await chrome.storage.local.set({ githubToken });
    }

    if (!githubRepo) {
      githubRepo = prompt("Enter repo to deploy to (e.g. username/my-site):");
      if (!githubRepo) { btn.disabled = false; btn.textContent = "📄 GH Pages"; return; }
      await chrome.storage.local.set({ githubRepo });
    }

    const headers = {
      Authorization: `token ${githubToken}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github.v3+json",
    };

    setStatus("Fetching all assets...", "grabbing");
    setProgress(10);
    const { html, files: bundleFiles } = await buildBundle(msg => setStatus(msg, "grabbing"));

    setStatus("Uploading blobs to GitHub...", "grabbing");
    setProgress(25);

    // Upload all blobs in parallel
    const allFiles = [{ path: "index.html", binary: false, content: html }, ...bundleFiles];
    const treeEntries = await Promise.all(allFiles.map(async f => {
      const body = f.binary
        ? JSON.stringify({ content: f.base64, encoding: "base64" })
        : JSON.stringify({ content: f.content || "", encoding: "utf-8" });
      const blobResp = await fetch(`https://api.github.com/repos/${githubRepo}/git/blobs`, {
        method: "POST", headers, body,
      });
      if (!blobResp.ok) { const e = await blobResp.json(); throw new Error(`Blob failed for ${f.path}: ${e.message}`); }
      const { sha } = await blobResp.json();
      return { path: f.path, mode: "100644", type: "blob", sha };
    }));
    setProgress(55);

    // Create tree
    const treeResp = await fetch(`https://api.github.com/repos/${githubRepo}/git/trees`, {
      method: "POST", headers,
      body: JSON.stringify({ tree: treeEntries }),
    });
    if (!treeResp.ok) { const e = await treeResp.json(); throw new Error(e.message); }
    const treeSha = (await treeResp.json()).sha;
    setProgress(70);

    // Create commit (orphan — no parent needed for gh-pages)
    const commitResp = await fetch(`https://api.github.com/repos/${githubRepo}/git/commits`, {
      method: "POST", headers,
      body: JSON.stringify({ message: "GHL Saver: deploy to GitHub Pages", tree: treeSha }),
    });
    if (!commitResp.ok) { const e = await commitResp.json(); throw new Error(e.message); }
    const newSha = (await commitResp.json()).sha;
    setProgress(70);

    // Push to gh-pages branch (create or force-update)
    const refUrl = `https://api.github.com/repos/${githubRepo}/git/refs/heads/gh-pages`;
    const checkRef = await fetch(refUrl, { headers });
    if (checkRef.ok) {
      await fetch(refUrl, { method: "PATCH", headers, body: JSON.stringify({ sha: newSha, force: true }) });
    } else {
      await fetch(`https://api.github.com/repos/${githubRepo}/git/refs`, {
        method: "POST", headers,
        body: JSON.stringify({ ref: "refs/heads/gh-pages", sha: newSha }),
      });
    }
    setProgress(85);

    // Enable GitHub Pages on gh-pages branch
    setStatus("Enabling GitHub Pages...", "grabbing");
    await fetch(`https://api.github.com/repos/${githubRepo}/pages`, {
      method: "POST",
      headers: { ...headers, Accept: "application/vnd.github.switcheroo-preview+json" },
      body: JSON.stringify({ source: { branch: "gh-pages", path: "/" } }),
    }); // 409 = already enabled — that's fine, ignore

    setProgress(100);
    const [owner, repoName] = githubRepo.split("/");
    const pagesUrl = `https://${owner}.github.io/${repoName}`;
    setStatus("Live on GitHub Pages! ✅", "done");
    const linkEl = document.getElementById("currentUrl");
    linkEl.innerHTML = `<a href="${pagesUrl}" target="_blank" style="color:#79b8ff;text-decoration:underline;">📄 ${pagesUrl}</a>`;

  } catch (err) {
    setStatus("GH Pages failed: " + err.message, "error");
    console.error("[Keep My GHL] GH Pages error:", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "📄 GH Pages";
  }
}

// ── Init ─────────────────────────────────────────────────
// ── Export GHL AI Studio Source Code ─────────────────────
// Reads the actual React/Vite/Tailwind project files from the GHL
// AI Studio editor — not the compiled output, the real source code.
async function exportSourceCode() {
  const btn = document.getElementById("btnSource");
  btn.disabled = true;
  btn.textContent = "⏳ Reading source files...";
  setProgress(0);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Must be on a GHL AI Studio / Vibe Builder project page
    const isStudio = tab.url && (
      tab.url.includes("/vibe/projects/") ||
      tab.url.includes("gohighlevel.com") ||
      tab.url.includes("leadconnectorhq.com")
    );
    if (!isStudio) {
      setStatus("Navigate to a GHL AI Studio project page first", "error");
      return;
    }

    setStatus("Connecting to GHL AI Studio file system...", "grabbing");
    setProgress(10);

    // ── Step 1: Check if interceptor.js already captured files ────────────
    // interceptor.js runs at document_start and patches fetch/XHR to grab
    // the project file payload as GHL loads it into WebContainers.
    const interceptCheck = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: () => {
        if (!window.__capturedSourceFiles) return null;
        return {
          files: window.__capturedSourceFiles,
          projectId: window.__capturedProjectId || null,
          method: "fetch-intercept (" + (window.__capturedSourceUrl || "unknown endpoint") + ")",
        };
      },
    });

    let interceptResult = interceptCheck?.[0]?.result;

    // ── Step 2: If not yet captured, reload the project data via API ──────
    // The interceptor needs the page to make its file-load network request.
    // If the user opened the popup before the page finished loading, or
    // navigated here without a fresh load, try the GHL API directly now.
    if (!interceptResult) {
      setStatus("No intercepted files yet — trying GHL API...", "grabbing");
      setProgress(25);

      const apiResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: async () => {
          const url = window.location.href;
          const projectMatch = url.match(/vibe\/projects\/(\w+)/);
          const projectId = projectMatch?.[1] || null;
          if (!projectId) return null;

          // Additional API patterns discovered by watching network traffic
          const apiCandidates = [
            `/api/v1/vibe/projects/${projectId}/files`,
            `/api/v1/vibe-builder/projects/${projectId}/files`,
            `/v2/api/vibe/projects/${projectId}/files`,
            `/v2/api/vibe-builder/projects/${projectId}/files`,
            `/api/vibe/projects/${projectId}/files`,
            `https://services.leadconnectorhq.com/vibe/projects/${projectId}/files`,
            `https://services.leadconnectorhq.com/vibe-builder/projects/${projectId}/files`,
            `https://backend.leadconnectorhq.com/vibe/projects/${projectId}/files`,
          ];

          // Grab auth token from localStorage
          let authToken = null;
          for (const key of Object.keys(localStorage)) {
            if (key.toLowerCase().includes("token") || key.toLowerCase().includes("auth")) {
              const val = localStorage.getItem(key);
              if (val && val.length > 20 && !val.startsWith("{")) {
                authToken = val;
                break;
              }
            }
          }

          for (const endpoint of apiCandidates) {
            try {
              const headers = { "Content-Type": "application/json" };
              if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
              const resp = await fetch(endpoint, { credentials: "include", headers });
              if (!resp.ok) continue;
              const data = await resp.json();

              // Normalize response into flat file map
              const rawFiles = data.files || data.data?.files || data.project?.files || data;
              if (!rawFiles || typeof rawFiles !== "object") continue;

              const files = {};
              const flatten = (obj, prefix = "") => {
                for (const [key, val] of Object.entries(obj)) {
                  const path = prefix ? `${prefix}/${key}` : `/${key}`;
                  if (typeof val === "string") {
                    files[path] = val;
                  } else if (val && typeof val === "object" && typeof val.content === "string") {
                    files[path] = val.content;
                  } else if (val && typeof val === "object") {
                    flatten(val, path);
                  }
                }
              };
              flatten(rawFiles);

              if (Object.keys(files).length > 0) {
                return { files, projectId, method: `GHL API (${endpoint})` };
              }
            } catch {}
          }
          return null;
        },
      });

      interceptResult = apiResults?.[0]?.result;
    }

    // ── Step 3: Fall back to full in-page extraction (WebContainers/IndexedDB) ──
    if (!interceptResult) {
      setStatus("Trying in-page file system access...", "grabbing");
      setProgress(40);

      const fallbackResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: extractStudioFiles,
      });
      interceptResult = fallbackResults?.[0]?.result;
    }

    const result = interceptResult;
    if (!result || result.error || !result.files) {
      setStatus(
        result?.error
          ? "Could not read source files: " + result.error
          : "No source files found. Open the project in AI Studio editor, then click Export Source again.",
        "error"
      );
      document.getElementById("sourceHint").style.display = "block";
      return;
    }

    const { files, projectId, method } = result;
    if (!files || Object.keys(files).length === 0) {
      setStatus("No source files found. Make sure you are on the AI Studio project page.", "error");
      return;
    }

    setProgress(60);
    setStatus(`Packaging ${Object.keys(files).length} source files (via ${method})...`, "grabbing");

    // Build ZIP with full project structure
    const zip = new JSZip();
    const root = zip.folder(`ghl-source-${projectId || Date.now()}`);

    for (const [path, content] of Object.entries(files)) {
      // Preserve directory structure
      const parts = path.replace(/^\//, "").split("/");
      const filename = parts.pop();
      let folder = root;
      for (const part of parts) {
        folder = folder.folder(part);
      }
      folder.file(filename, content || "");
    }

    // Add a README explaining the source export
    root.file("KEEP-MY-GHL-SOURCE.md",
`# GHL AI Studio — Source Code Export
**Project ID:** ${projectId || "unknown"}
**Exported:** ${new Date().toISOString()}
**Method:** ${method}

## What this is
This is the full React/Vite/TypeScript/Tailwind source code from your GHL AI Studio project.
Unlike the rendered HTML export, this is the actual editable source you can build on.

## How to run locally
\`\`\`bash
npm install        # or: bun install
npm run dev        # or: bun dev
\`\`\`
Then open http://localhost:5173

## How to build for production
\`\`\`bash
npm run build
\`\`\`
Output goes to the \`dist/\` folder — deploy that folder to any static host.

## Deploy to Netlify
1. Run \`npm run build\`
2. Drag the \`dist/\` folder to app.netlify.com/drop

## Deploy to Vercel
\`\`\`bash
npx vercel
\`\`\`
`);

    setProgress(85);
    setStatus("Compressing...", "grabbing");
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });

    // Store files + projectId for deploy actions
    window.__sourceFiles = files;
    window.__sourceProjectId = projectId || `ghl-${Date.now()}`;
    window.__sourceBlob = blob;

    setProgress(100);
    setStatus(`✅ ${Object.keys(files).length} source files ready — choose what to do below`, "done");

    // Show the source action panel
    showSourcePanel(Object.keys(files).length);

  } catch (err) {
    setStatus("Source export error: " + err.message, "error");
    console.error("[Keep My GHL] Source export error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "📦 Export Source (Dev)";
  }
}

function showSourcePanel(fileCount) {
  let panel = document.getElementById("sourcePanel");
  if (!panel) return;
  panel.classList.add("show");
  document.getElementById("sourceFileCount").textContent = fileCount + " files captured";
}

// ── Source export token helpers ───────────────────────────
async function getVercelToken() {
  let { vercelToken } = await chrome.storage.local.get(["vercelToken"]);
  if (!vercelToken) {
    vercelToken = prompt("Enter your Vercel API token (vercel.com/account/tokens):");
    if (!vercelToken) return null;
    await chrome.storage.local.set({ vercelToken });
  }
  return vercelToken;
}

async function getGitHubToken() {
  let { githubToken } = await chrome.storage.local.get(["githubToken"]);
  if (!githubToken) {
    githubToken = prompt("Enter your GitHub Personal Access Token (needs repo scope):");
    if (!githubToken) return null;
    await chrome.storage.local.set({ githubToken });
  }
  return githubToken;
}

async function openRepoPicker() {
  const { githubToken } = await chrome.storage.local.get(["githubToken"]);
  if (!githubToken) return;
  setStatus("Loading repositories...", "grabbing");
  try {
    const [repos, { githubRepo: lastRepo }] = await Promise.all([
      fetchUserRepos(githubToken),
      chrome.storage.local.get(["githubRepo"]),
    ]);
    showSourceRepoPicker(githubToken, repos, lastRepo || null);
    setStatus("Select a repo to push source files to", "ready");
  } catch (err) {
    setStatus("Error loading repos: " + err.message, "error");
    const btn = document.getElementById("btnSourceGitHub");
    if (btn) { btn.disabled = false; btn.textContent = "🐙 Push to GitHub"; }
  }
}

function showSourceRepoPicker(token, repos, lastRepo) {
  const picker = document.getElementById("repoPicker");
  const listEl = document.getElementById("repoList");
  const searchEl = document.getElementById("repoSearch");

  function renderList(filter) {
    const q = (filter || "").toLowerCase();
    const filtered = repos.filter(r => !q || r.full_name.toLowerCase().includes(q));
    let html = "";
    if (!q && lastRepo) {
      html += `<div class="repo-item repo-item--last" data-repo="${lastRepo}">
        <span class="repo-name">${lastRepo}</span><span class="repo-badge">last used</span>
      </div>`;
    }
    filtered.forEach(r => {
      if (!q && r.full_name === lastRepo) return;
      html += `<div class="repo-item" data-repo="${r.full_name}">
        <span class="repo-name">${r.full_name}</span>
        <span class="repo-vis">${r.private ? "private" : "public"}</span>
      </div>`;
    });
    if (!html) html = '<div class="repo-empty">No repos found</div>';
    listEl.innerHTML = html;
    listEl.querySelectorAll(".repo-item").forEach(el => {
      el.addEventListener("click", () => { hidePicker(); doSourcePush(token, el.dataset.repo); });
    });
  }

  renderList("");
  searchEl.value = "";
  searchEl.addEventListener("input", () => renderList(searchEl.value));
  picker.classList.add("show");
  setTimeout(() => searchEl.focus(), 50);

  document.getElementById("btnCreateNewRepo").onclick = () => {
    const name = document.getElementById("newRepoName").value.trim();
    if (!name) { document.getElementById("newRepoName").focus(); return; }
    hidePicker();
    doSourcePush(token, name);
  };
  document.getElementById("newRepoName").onkeydown = e => {
    if (e.key === "Enter") document.getElementById("btnCreateNewRepo").click();
  };
  document.getElementById("btnCancelPicker").onclick = () => {
    hidePicker();
    window.__pendingSourcePush = false;
    const btn = document.getElementById("btnSourceGitHub");
    if (btn) { btn.disabled = false; btn.textContent = "🐙 Push to GitHub"; }
  };
}

async function doSourcePush(githubToken, repo) {
  const files = window.__sourceFiles;
  const projectId = window.__sourceProjectId;
  if (!files) { setStatus("No source files to push", "error"); return; }
  window.__pendingSourcePush = false;

  if (!repo.includes("/")) {
    const userResp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${githubToken}`, Accept: "application/vnd.github.v3+json" },
    });
    if (userResp.ok) {
      const { login } = await userResp.json();
      repo = `${login}/${repo}`;
    }
  }

  await chrome.storage.local.set({ githubRepo: repo });

  const btn = document.getElementById("btnSourceGitHub");
  btn.disabled = true;
  btn.textContent = "⏳ Pushing...";
  setProgress(5);

  const headers = {
    Authorization: `token ${githubToken}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github.v3+json",
  };

  try {
    const fileEntries = Object.entries(files);
    setStatus(`Pushing ${fileEntries.length} source files to ${repo}...`, "grabbing");

    let repoResp = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoResp.ok && repoResp.status === 404) {
      setStatus("Creating repo on GitHub...", "grabbing");
      const createResp = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: repo.split("/").pop(),
          description: `GHL Source Export — ${projectId}`,
          private: false,
          auto_init: true,
        }),
      });
      if (!createResp.ok) {
        const e = await createResp.json();
        throw new Error(`Could not create repo: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1500));
    } else if (!repoResp.ok) {
      const e = await repoResp.json();
      throw new Error(`GitHub error (${repoResp.status}): ${e.message}`);
    }

    setProgress(15);

    for (let i = 0; i < fileEntries.length; i++) {
      const [path, content] = fileEntries[i];
      const cleanPath = path.replace(/^\//, "");
      setStatus(`Pushing ${cleanPath} (${i + 1}/${fileEntries.length})...`, "grabbing");

      let existingSha = null;
      const getResp = await fetch(`https://api.github.com/repos/${repo}/contents/${cleanPath}`, { headers });
      if (getResp.ok) existingSha = (await getResp.json()).sha;

      const encoded = typeof content === "string" ? toBase64(content) : content;
      const putResp = await fetch(`https://api.github.com/repos/${repo}/contents/${cleanPath}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message: existingSha ? `update ${cleanPath}` : `add ${cleanPath}`,
          content: encoded,
          ...(existingSha && { sha: existingSha }),
        }),
      });
      if (!putResp.ok) {
        const e = await putResp.json();
        throw new Error(`Failed to push ${cleanPath}: ${e.message}`);
      }
      setProgress(15 + Math.round(((i + 1) / fileEntries.length) * 80));
    }

    setProgress(100);
    setStatus(`✅ Pushed ${fileEntries.length} source files to ${repo}`, "done");
    document.getElementById("currentUrl").innerHTML =
      `<a href="https://github.com/${repo}" target="_blank" style="color:#4caf50;text-decoration:underline;">✅ github.com/${repo}</a>`;

  } catch (err) {
    setStatus("GitHub push error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🐙 Push to GitHub";
  }
}

async function sourceDownloadZip() {
  const blob = window.__sourceBlob;
  const projectId = window.__sourceProjectId;
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ghl-source-${projectId}.zip`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("✅ Source ZIP downloaded", "done");
}

async function sourceDeployVercel() {
  const files = window.__sourceFiles;
  const projectId = window.__sourceProjectId;
  if (!files) { setStatus("Capture source files first", "error"); return; }

  const btn = document.getElementById("btnSourceVercel");
  btn.disabled = true;
  btn.textContent = "⏳ Deploying...";

  try {
    const token = await getVercelToken();
    if (!token) { setStatus("Enter your Vercel token in settings", "error"); return; }

    setStatus("Creating Vercel project (Vite/React build)...", "grabbing");
    setProgress(20);

    // Create project with Vite framework so Vercel runs the build server-side
    const projName = `ghl-source-${projectId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48);
    const createResp = await fetch("https://api.vercel.com/v9/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: projName,
        framework: "vite",
        buildCommand: "npm run build",
        outputDirectory: "dist",
        installCommand: "npm install",
      }),
    });
    const proj = await createResp.json();
    if (!createResp.ok && proj.error?.code !== "project_already_exists") {
      throw new Error(proj.error?.message || "Failed to create project");
    }
    const finalProjName = proj.name || projName;

    setProgress(40);
    setStatus("Uploading source files...", "grabbing");

    // Build file list for deployment — text files as utf8, binaries as base64
    const textExts = new Set([".ts",".tsx",".js",".jsx",".css",".html",".json",".md",".txt",".svg",".env",".gitignore",".npmrc"]);
    const deployFiles = [];
    for (const [path, content] of Object.entries(files)) {
      const ext = path.match(/(\.[^.]+)$/)?.[1]?.toLowerCase() || "";
      const isText = textExts.has(ext) || !ext;
      deployFiles.push({
        file: path.replace(/^\//, ""),
        data: content,
        encoding: isText ? "utf-8" : "base64",
      });
    }

    setProgress(60);
    const deployResp = await fetch(`https://api.vercel.com/v13/deployments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: finalProjName,
        files: deployFiles,
        projectSettings: {
          framework: "vite",
          buildCommand: "npm run build",
          outputDirectory: "dist",
          installCommand: "npm install",
        },
        target: "production",
      }),
    });
    const deploy = await deployResp.json();
    if (!deployResp.ok) throw new Error(deploy.error?.message || "Deploy failed");

    setProgress(80);
    setStatus("Build running on Vercel (takes ~60s)...", "grabbing");

    // Poll until ready
    const deployId = deploy.id;
    let liveUrl = deploy.url ? `https://${deploy.url}` : null;
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 3000));
      const check = await fetch(`https://api.vercel.com/v13/deployments/${deployId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const status = await check.json();
      if (status.readyState === "READY") {
        liveUrl = `https://${status.url}`;
        break;
      }
      if (status.readyState === "ERROR") throw new Error("Vercel build failed — check your project's build logs");
      attempts++;
    }

    setProgress(100);
    setStatus(`✅ Live on Vercel → ${liveUrl}`, "done");
    if (liveUrl) {
      const link = document.createElement("a");
      link.href = liveUrl;
      link.target = "_blank";
      link.textContent = liveUrl;
      link.style.cssText = "display:block;color:#667eea;font-size:11px;margin-top:6px;word-break:break-all;";
      document.getElementById("status").appendChild(link);
    }

  } catch (err) {
    setStatus("Vercel deploy error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "▲ Deploy to Vercel";
  }
}

async function sourcePushGitHub() {
  const files = window.__sourceFiles;
  const projectId = window.__sourceProjectId;
  if (!files) { setStatus("Capture source files first", "error"); return; }

  const token = await getGitHubToken();
  if (!token) { setStatus("Connect GitHub first", "error"); return; }

  const btn = document.getElementById("btnSourceGitHub");
  btn.disabled = true;
  btn.textContent = "⏳ Pushing...";

  try {
    // Re-use existing repo picker flow but with source files
    window.__pendingSourcePush = true;
    openRepoPicker();
  } catch (err) {
    setStatus("GitHub push error: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = "🐙 Push to GitHub";
  }
}

// Injected into the GHL AI Studio page — runs in page context.
// Tries multiple methods to read the project source files.
function extractStudioFiles() {
  return new Promise(async resolve => {
    const url = window.location.href;
    const projectMatch = url.match(/vibe\/projects\/(\w+)/);
    const locationMatch = url.match(/location\/([a-zA-Z0-9]+)\//);
    const projectId = projectMatch?.[1] || null;
    const locationId = locationMatch?.[1] || null;

    // ── Method 1: WebContainers / Bolt global ──────────────
    // GHL AI Studio likely uses StackBlitz WebContainers.
    const wcInstance =
      window.webcontainerInstance ||
      window.__webcontainer__ ||
      window._webcontainer ||
      window.bolt?.webcontainer ||
      window.__bolt?.webcontainer;

    if (wcInstance && wcInstance.fs) {
      try {
        const files = {};
        async function readDir(path) {
          const entries = await wcInstance.fs.readdir(path, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
            if (entry.isDirectory()) {
              // Skip node_modules and .git
              if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
              await readDir(fullPath);
            } else {
              try {
                const content = await wcInstance.fs.readFile(fullPath, "utf-8");
                files[fullPath] = content;
              } catch {}
            }
          }
        }
        await readDir("/");
        if (Object.keys(files).length > 0) {
          return resolve({ files, projectId, method: "WebContainers FS" });
        }
      } catch (e) {
        console.log("[Keep My GHL] WebContainers method failed:", e.message);
      }
    }

    // ── Method 2: GHL internal API ─────────────────────────
    // Try GHL's own API endpoints using the browser session (cookies auto-included).
    if (projectId) {
      const apiCandidates = [
        `/api/v1/vibe/projects/${projectId}/files`,
        `/v2/api/vibe-builder/projects/${projectId}/files`,
        `/api/vibe/projects/${projectId}/files`,
        `https://services.leadconnectorhq.com/vibe/projects/${projectId}/files`,
        `https://services.leadconnectorhq.com/vibe-builder/projects/${projectId}/files`,
      ];

      // Try to find auth token in localStorage
      let authToken = null;
      for (const key of Object.keys(localStorage)) {
        if (key.toLowerCase().includes("token") || key.toLowerCase().includes("auth")) {
          const val = localStorage.getItem(key);
          if (val && val.length > 20 && !val.startsWith("{")) {
            authToken = val;
            break;
          }
        }
      }

      for (const endpoint of apiCandidates) {
        try {
          const headers = { "Content-Type": "application/json" };
          if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
          const resp = await fetch(endpoint, { credentials: "include", headers });
          if (resp.ok) {
            const data = await resp.json();
            // GHL might return { files: {...} } or { data: { files: {...} } } or an array
            const rawFiles = data.files || data.data?.files || data;
            if (rawFiles && typeof rawFiles === "object") {
              const files = {};
              const flatten = (obj, prefix = "") => {
                for (const [key, val] of Object.entries(obj)) {
                  const path = prefix ? `${prefix}/${key}` : `/${key}`;
                  if (typeof val === "string") {
                    files[path] = val;
                  } else if (val && typeof val === "object" && val.content) {
                    files[path] = val.content;
                  } else if (val && typeof val === "object") {
                    flatten(val, path);
                  }
                }
              };
              flatten(rawFiles);
              if (Object.keys(files).length > 0) {
                return resolve({ files, projectId, method: `GHL API (${endpoint})` });
              }
            }
          }
        } catch {}
      }
    }

    // ── Method 3: IndexedDB scan ───────────────────────────
    // WebContainers stores files in IndexedDB under various keys.
    try {
      const dbNames = await indexedDB.databases?.() || [];
      for (const dbInfo of dbNames) {
        if (!dbInfo.name) continue;
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open(dbInfo.name);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const storeNames = [...db.objectStoreNames];
        for (const storeName of storeNames) {
          if (!storeName.toLowerCase().includes("file") && !storeName.toLowerCase().includes("fs")) continue;
          try {
            const files = {};
            await new Promise((res, rej) => {
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              const req = store.getAll();
              req.onsuccess = () => {
                for (const item of req.result || []) {
                  if (item.path && item.content) files[item.path] = item.content;
                  else if (item.name && item.data) files[item.name] = item.data;
                }
                res();
              };
              req.onerror = () => res();
            });
            db.close();
            if (Object.keys(files).length > 0) {
              return resolve({ files, projectId, method: `IndexedDB (${dbInfo.name}/${storeName})` });
            }
          } catch {}
        }
        db.close();
      }
    } catch (e) {
      console.log("[Keep My GHL] IndexedDB scan failed:", e.message);
    }

    // ── Method 4: Scan window globals for file maps ────────
    // Some editors expose files as a plain object on window.
    const globalKeys = Object.getOwnPropertyNames(window);
    for (const key of globalKeys) {
      if (key.startsWith("_") || key.length < 3) continue;
      try {
        const val = window[key];
        if (!val || typeof val !== "object") continue;
        // Look for objects that look like file maps: { "src/App.tsx": "...", ... }
        const entries = Object.entries(val);
        if (entries.length < 2 || entries.length > 500) continue;
        const looksLikeFiles = entries.filter(([k, v]) =>
          typeof k === "string" && k.includes(".") &&
          (k.endsWith(".tsx") || k.endsWith(".ts") || k.endsWith(".jsx") ||
           k.endsWith(".js") || k.endsWith(".css") || k.endsWith(".json") || k.endsWith(".html")) &&
          typeof v === "string" && v.length > 0
        );
        if (looksLikeFiles.length >= 3) {
          const files = Object.fromEntries(
            looksLikeFiles.map(([k, v]) => [k.startsWith("/") ? k : `/${k}`, v])
          );
          return resolve({ files, projectId, method: `window.${key}` });
        }
      } catch {}
    }

    resolve({ error: "Could not access source files. Try: open a file in the editor first, or make sure you are on the project page (not just the dashboard).", files: {}, projectId, method: "none" });
  });
}

// ── Cloudflare Pages ─────────────────────────────────────
async function deployToCloudflare() {
  if (!projectData) return;
  const btn = document.getElementById("btnCloudflare");
  btn.disabled = true;
  btn.textContent = "⏳ Deploying...";
  setProgress(5);

  try {
    let { cfToken, cfAccountId } = await chrome.storage.local.get(["cfToken", "cfAccountId"]);

    if (!cfToken) {
      cfToken = prompt("Cloudflare API Token (Pages:Edit permission):");
      if (!cfToken) { btn.disabled = false; btn.textContent = "☁️ CF Pages"; return; }
    }
    if (!cfAccountId) {
      cfAccountId = prompt("Cloudflare Account ID (right sidebar of dash.cloudflare.com):");
      if (!cfAccountId) { btn.disabled = false; btn.textContent = "☁️ CF Pages"; return; }
    }
    // Project name derived fresh per-deploy from the grabbed page URL — never locked in storage
    const domain = (() => { try { return new URL(projectData.pageUrl).hostname.replace(/\./g, "-"); } catch { return "ghl-site"; } })();
    let cfProject = prompt("Project name (new = creates it, existing = redeploys):", domain.substring(0, 28) + "-" + Date.now().toString().slice(-5));
    if (!cfProject) { btn.disabled = false; btn.textContent = "☁️ CF Pages"; return; }
    cfProject = cfProject.toLowerCase().replace(/[^a-z0-9-]/g, "-").substring(0, 58);
    // Save credentials only (not project name — each site gets its own)
    await chrome.storage.local.set({ cfToken, cfAccountId });

    const auth = { Authorization: `Bearer ${cfToken}` };

    setStatus("Creating Cloudflare Pages project...", "grabbing");
    setProgress(10);
    const createResp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: cfProject, production_branch: "main" }),
    });
    if (!createResp.ok && createResp.status !== 409) {
      const e = await createResp.json();
      throw new Error(e.errors?.[0]?.message || `Project creation failed (${createResp.status}) — check your Account ID and token`);
    }

    setStatus("Building bundle...", "grabbing");
    setProgress(20);
    const { html, files: bundleFiles } = await buildBundle(msg => setStatus(msg, "grabbing"));
    const allFiles = [
      { path: "/index.html", content: html, binary: false },
      ...bundleFiles.map(f => ({ ...f, path: "/" + f.path })),
    ];

    setStatus("Computing hashes...", "grabbing");
    setProgress(50);
    const encoder = new TextEncoder();
    const entries = await Promise.all(allFiles.map(async f => {
      const bytes = f.binary
        ? Uint8Array.from(atob(f.base64 || ""), c => c.charCodeAt(0))
        : encoder.encode(f.content || "");
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
      return { path: f.path, hash, bytes, binary: f.binary };
    }));

    const manifest = {};
    for (const e of entries) manifest[e.path] = e.hash;

    setStatus("Uploading to Cloudflare Pages...", "grabbing");
    setProgress(65);
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    for (const e of entries) {
      const mime = e.binary ? "application/octet-stream" : (e.path.endsWith(".html") ? "text/html" : e.path.endsWith(".css") ? "text/css" : "text/plain");
      form.append(e.hash, new Blob([e.bytes], { type: mime }), e.path.split("/").pop());
    }

    const deployResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/pages/projects/${cfProject}/deployments`,
      { method: "POST", headers: auth, body: form }
    );

    if (!deployResp.ok) {
      const err = await deployResp.json();
      throw new Error(err.errors?.[0]?.message || "Cloudflare deploy failed");
    }
    const deploy = await deployResp.json();
    const siteUrl = deploy.result?.url ? `https://${deploy.result.url}` : `https://${cfProject}.pages.dev`;

    setProgress(100);
    setStatus("Live on Cloudflare Pages! ✅", "done");
    document.getElementById("currentUrl").innerHTML =
      `<a href="${siteUrl}" target="_blank" style="color:#f6821f;text-decoration:underline;">☁️ ${siteUrl}</a>`;

  } catch (err) {
    setStatus("Cloudflare failed: " + err.message, "error");
    console.error("[Keep My GHL] Cloudflare error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "☁️ CF Pages";
  }
}

// ── Version History & Snapshots ───────────────────────────
async function saveSnapshot(data) {
  const snap = {
    id: Date.now(),
    url: data.pageUrl || data.frameUrl || "",
    title: data.pageTitle || "Untitled",
    grabbedAt: data.grabbedAt || new Date().toISOString(),
    auto: false,
    htmlLength: data.fullHtml?.length || 0,
    html: (data.fullHtml || "").substring(0, 400000),
    counts: {
      css: data.cssCount || 0,
      js: data.jsCount || 0,
      images: data.imageCount || 0,
      schemas: data.schemaCount || 0,
    },
  };
  const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
  snapshots.unshift(snap);
  if (snapshots.length > 25) snapshots.splice(25);
  await chrome.storage.local.set({ snapshots });
  renderSnapList(snapshots);
}

async function loadSnapshots() {
  const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
  renderSnapList(snapshots);
}

function renderSnapList(snapshots) {
  const list = document.getElementById("snapList");
  if (!list) return;
  if (!snapshots.length) {
    list.innerHTML = '<div class="snap-empty">No snapshots yet — grab a project to save one.</div>';
    return;
  }
  list.innerHTML = snapshots.map(s => {
    const dt = new Date(s.grabbedAt);
    const label = dt.toLocaleDateString() + " " + dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const title = (s.title || "Untitled").substring(0, 30);
    const badge = s.auto ? '<span class="snap-auto-badge">auto</span>' : "";
    const kb = Math.round(s.htmlLength / 1024);
    return `<div class="snap-item">
      <div class="snap-info">
        <strong>${title}${badge}</strong>
        <span>${label} &middot; ${kb}KB &middot; ${s.counts.css}css ${s.counts.js}js ${s.counts.images}img</span>
      </div>
      <div class="snap-acts">
        <button class="snap-btn" onclick="restoreSnapshot(${s.id})">Restore</button>
        <button class="snap-btn del" onclick="deleteSnapshot(${s.id})">✕</button>
      </div>
    </div>`;
  }).join("");
}

async function restoreSnapshot(id) {
  const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
  const snap = snapshots.find(s => s.id === id);
  if (!snap) return;
  const parsed = parseHtmlToData(snap.html, snap.url || "https://unknown.com");
  parsed.pageUrl = snap.url;
  parsed.grabbedAt = snap.grabbedAt;
  projectData = parsed;

  document.getElementById("btnDownload").disabled = false;
  document.getElementById("btnGitHub").disabled = false;
  document.getElementById("btnNetlify").disabled = false;
  document.getElementById("btnVercel").disabled = false;
  document.getElementById("btnGHPages").disabled = false;
  document.getElementById("btnCloudflare").disabled = false;
  document.getElementById("btnSEOAudit").disabled = false;
  document.getElementById("btnBrandKit").disabled = false;
  document.getElementById("btnGDPR").disabled = false;
  document.getElementById("btnScrub").disabled = false;
  showResults(parsed);
  setStatus("Snapshot restored: " + snap.title, "done");
}

async function deleteSnapshot(id) {
  const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
  const updated = snapshots.filter(s => s.id !== id);
  await chrome.storage.local.set({ snapshots: updated });
  renderSnapList(updated);
}

async function initAutoBackup() {
  const { autoBackupHours = 0 } = await chrome.storage.local.get(["autoBackupHours"]);
  const toggle = document.getElementById("autoBackupToggle");
  const label = document.getElementById("autoBackupLabel");
  const pills = document.getElementById("schedulePills");
  const on = autoBackupHours > 0;
  toggle.classList.toggle("on", on);
  label.textContent = on ? `Every ${autoBackupHours >= 168 ? "week" : autoBackupHours + "h"}` : "Off";
  if (pills) pills.style.display = on ? "flex" : "none";
  document.querySelectorAll(".pill").forEach(p => {
    p.classList.toggle("active", parseInt(p.dataset.h) === autoBackupHours);
  });
}

async function toggleAutoBackup() {
  const { autoBackupHours = 0 } = await chrome.storage.local.get(["autoBackupHours"]);
  if (autoBackupHours > 0) {
    await chrome.storage.local.set({ autoBackupHours: 0 });
    chrome.runtime.sendMessage({ action: "clearAlarm" });
  } else {
    await chrome.storage.local.set({ autoBackupHours: 24 });
    chrome.runtime.sendMessage({ action: "setAlarm", hours: 24 });
  }
  initAutoBackup();
}

async function setSchedule(hours) {
  await chrome.storage.local.set({ autoBackupHours: hours });
  chrome.runtime.sendMessage({ action: "setAlarm", hours });
  initAutoBackup();
}

// ── SEO Audit ─────────────────────────────────────────────
function runSEOAudit() {
  if (!projectData) return;

  const checks = [];
  let earned = 0, total = 0;

  function chk(label, pass, pts, fix) {
    total += pts;
    if (pass) earned += pts;
    else checks.push({ label, fix, pts, pass });
  }

  const title = projectData.pageTitle || "";
  chk("Page title present", title.length > 0, 5, "Add a <title> tag to your page");
  chk("Title length 30–60 chars", title.length >= 30 && title.length <= 60, 3,
    `Title is ${title.length} chars — aim for 30–60`);

  const meta = projectData.metaTags?.meta || [];
  const desc = meta.find(m => m.name === "description")?.content || "";
  chk("Meta description present", desc.length > 0, 5, "Add <meta name='description' content='…'>");
  chk("Description length 120–160 chars", desc.length >= 120 && desc.length <= 160, 3,
    `Description is ${desc.length} chars — aim for 120–160`);

  chk("Canonical URL set", !!projectData.metaTags?.canonical, 3,
    "Add <link rel='canonical' href='YOUR-URL'>");

  const og = projectData.metaTags?.og || [];
  chk("OG title set", og.some(m => m.property === "og:title"), 3, "Add <meta property='og:title'>");
  chk("OG image set", og.some(m => m.property === "og:image"), 4, "Add <meta property='og:image'> for social sharing");
  chk("OG description set", og.some(m => m.property === "og:description"), 2, "Add <meta property='og:description'>");

  const schemas = projectData.schemas || [];
  chk("JSON-LD structured data present", schemas.length > 0, 4,
    "Add JSON-LD schema markup to improve rich snippets");

  const imgsMissingAlt = (projectData.images || []).filter(i => !i.alt || !i.alt.trim()).length;
  chk("All images have alt text", imgsMissingAlt === 0, 3,
    `${imgsMissingAlt} image${imgsMissingAlt === 1 ? "" : "s"} missing alt text`);

  chk("Page loads over HTTPS", (projectData.pageUrl || "").startsWith("https://"), 2,
    "Ensure your site uses HTTPS");

  const pct = Math.round((earned / total) * 100);
  const grade = pct >= 90 ? "A" : pct >= 75 ? "B" : pct >= 55 ? "C" : "D";
  const cls = pct >= 90 ? "score-a" : pct >= 75 ? "score-b" : pct >= 55 ? "score-c" : "score-d";

  const circle = document.getElementById("auditCircle");
  circle.textContent = grade;
  circle.className = "score-circle " + cls;
  document.getElementById("auditScoreTitle").textContent = `${pct}% — ${earned}/${total} points`;
  document.getElementById("auditScoreSub").textContent =
    checks.length === 0 ? "Perfect score! All checks passed." : `${checks.length} issue${checks.length === 1 ? "" : "s"} found`;

  document.getElementById("auditList").innerHTML = checks.map(c =>
    `<div class="audit-row">
      <span class="audit-icon">❌</span>
      <div>
        <div class="audit-text">${c.label}</div>
        <div class="audit-fix">→ ${c.fix}</div>
      </div>
    </div>`
  ).join("") + (checks.length === 0 ? '<div class="audit-row"><span class="audit-icon">✅</span><div class="audit-text">All SEO checks passed</div></div>' : "");

  document.getElementById("auditPanel").classList.add("show");
}

// ── Brand Kit Extractor ───────────────────────────────────
function extractBrandKit() {
  if (!projectData) return;

  const allCss = (projectData.stylesheets || [])
    .filter(s => s.content)
    .map(s => s.content)
    .join("\n");

  const colorSet = new Set();
  const colorRe = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]+\)/g;
  const skip = new Set(["#000","#000000","#fff","#ffffff","#transparent"]);
  (allCss.match(colorRe) || []).forEach(c => {
    const n = c.toLowerCase().replace(/\s/g, "");
    if (!skip.has(n)) colorSet.add(c);
  });
  const colors = [...colorSet].slice(0, 48);

  const fontSet = new Set();
  (allCss.match(/font-family\s*:\s*([^;}{]+)/g) || []).forEach(f => {
    f.replace("font-family", "").replace(":", "").trim()
      .split(",")
      .map(s => s.trim().replace(/['"]/g, ""))
      .filter(s => s && !["inherit","initial","sans-serif","serif","monospace","system-ui","-apple-system"].includes(s))
      .forEach(s => fontSet.add(s));
  });
  (projectData.fonts || []).forEach(f => {
    const m = (f.url || "").match(/family=([^&:]+)/);
    if (m) fontSet.add(decodeURIComponent(m[1]).replace(/\+/g, " "));
  });
  const fonts = [...fontSet].slice(0, 20);

  const colorsEl = document.getElementById("brandColors");
  colorsEl.innerHTML = colors.length
    ? colors.map(c => `<div class="swatch" style="background:${c}" title="${c}" onclick="navigator.clipboard.writeText('${c}')"></div>`).join("")
    : '<span style="color:#333;font-size:10px">No colors extracted from inline CSS</span>';

  const fontsEl = document.getElementById("brandFonts");
  fontsEl.innerHTML = fonts.length
    ? fonts.map(f => `<span class="font-pill">${f}</span>`).join("")
    : '<span style="color:#333;font-size:10px">No custom fonts detected</span>';

  window.__brandKit = { colors, fonts, url: projectData.pageUrl, extractedAt: new Date().toISOString() };
  document.getElementById("brandPanel").classList.add("show");
}

function exportBrandKit() {
  if (!window.__brandKit) return;
  const json = JSON.stringify(window.__brandKit, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "brand-kit.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── GDPR / Compliance Check ───────────────────────────────
function runGDPRCheck() {
  if (!projectData) return;

  const html = (projectData.fullHtml || "").toLowerCase();
  const links = projectData.links || [];

  const checks = [
    {
      label: "Privacy policy link present",
      pass: links.some(l => /privacy/i.test(l.text) || /privacy/i.test(l.href)),
      fix: "Link to your privacy policy page",
    },
    {
      label: "Terms of service link present",
      pass: links.some(l => /terms|tos/i.test(l.text) || /terms/i.test(l.href)),
      fix: "Link to your terms of service",
    },
    {
      label: "Cookie consent / notice",
      pass: /cookie|gdpr|consent/i.test(html),
      fix: "Add a cookie consent banner (required in EU)",
    },
    {
      label: "No unmasked phone numbers in plain HTML",
      pass: !(html.match(/\b(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) || []).length > 3,
      fix: "Consider masking phone numbers to reduce spam harvesting",
    },
    {
      label: "Meta robots not set to noindex",
      pass: !html.includes('name="robots"') || !html.includes("noindex"),
      fix: "Check: <meta name='robots'> should not contain 'noindex' on public pages",
    },
    {
      label: "Canonical URL present",
      pass: !!projectData.metaTags?.canonical,
      fix: "Add <link rel='canonical'> to prevent duplicate content penalties",
    },
    {
      label: "HTTPS",
      pass: (projectData.pageUrl || "").startsWith("https://"),
      fix: "All pages should load over HTTPS",
    },
  ];

  document.getElementById("complianceList").innerHTML = checks.map(c =>
    `<div class="compliance-row">
      <span class="compliance-icon">${c.pass ? "✅" : "⚠️"}</span>
      <div>
        <div class="compliance-text">${c.label}</div>
        ${!c.pass ? `<div class="compliance-sub">→ ${c.fix}</div>` : ""}
      </div>
    </div>`
  ).join("");

  document.getElementById("compliancePanel").classList.add("show");
}

// ── Tracking Script Scrubber ──────────────────────────────
function scrubTrackingScripts() {
  if (!projectData) return;
  let html = projectData.fullHtml || "";
  let count = 0;

  const patterns = [
    // GHL / LeadConnector
    { re: /<script[^>]*(?:msgsndr|leadconnector|highlevel)[^>]*>[\s\S]*?<\/script>/gi, name: "GHL chat widget" },
    // Google Tag Manager
    { re: /<script[^>]*googletagmanager\.com\/gtm[^>]*>[\s\S]*?<\/script>/gi, name: "Google Tag Manager" },
    { re: /<!-- Google Tag Manager[\s\S]*?<!-- End Google Tag Manager -->/gi, name: "GTM noscript" },
    // Google Analytics
    { re: /<script[^>]*google-analytics\.com[^>]*>[\s\S]*?<\/script>/gi, name: "Google Analytics" },
    { re: /<script[^>]*gtag[^>]*>[\s\S]*?<\/script>/gi, name: "gtag.js" },
    // Facebook Pixel
    { re: /<script[^>]*connect\.facebook\.net[^>]*>[\s\S]*?<\/script>/gi, name: "Facebook Pixel" },
    { re: /<!-- Facebook Pixel[\s\S]*?<!-- End Facebook Pixel[^>]*-->/gi, name: "FB Pixel block" },
    // HotJar
    { re: /<script[^>]*hotjar[^>]*>[\s\S]*?<\/script>/gi, name: "HotJar" },
    // Intercom
    { re: /<script[^>]*intercomcdn[^>]*>[\s\S]*?<\/script>/gi, name: "Intercom" },
    // TikTok Pixel
    { re: /<script[^>]*analytics\.tiktok[^>]*>[\s\S]*?<\/script>/gi, name: "TikTok Pixel" },
    // Clarity
    { re: /<script[^>]*clarity\.ms[^>]*>[\s\S]*?<\/script>/gi, name: "Microsoft Clarity" },
  ];

  const removed = [];
  for (const { re, name } of patterns) {
    const before = html.length;
    html = html.replace(re, "");
    if (html.length < before) { removed.push(name); count++; }
  }

  projectData.fullHtml = html;

  const notice = document.getElementById("scrubNotice");
  notice.textContent = count > 0
    ? `✅ Removed ${count} tracking script${count === 1 ? "" : "s"}: ${removed.join(", ")}. Re-download or re-deploy to get the clean version.`
    : "ℹ️ No known tracking scripts found in the captured HTML.";
  notice.classList.add("show");
}

// ── Multi-Page Funnel Crawler ─────────────────────────────
async function crawlFunnel() {
  if (!projectData) {
    setStatus("Grab a page first before crawling", "error");
    return;
  }

  const btn = document.getElementById("btnCrawl");
  btn.disabled = true;
  btn.textContent = "⏳ Crawling...";

  try {
    const rawUrl = projectData.pageUrl || projectData.frameUrl || "";
    if (!rawUrl.startsWith("http")) {
      setStatus("Cannot crawl — no valid page URL on the grabbed project", "error");
      btn.disabled = false; btn.textContent = "🕸️ Crawl Entire Funnel";
      return;
    }
    const base = new URL(rawUrl);
    const baseHost = base.hostname;

    const sameDomainLinks = [...new Set(
      (projectData.links || [])
        .map(l => l.href)
        .filter(href => {
          try {
            const u = new URL(href);
            return u.hostname === baseHost && u.pathname !== base.pathname;
          } catch { return false; }
        })
        .slice(0, 10)
    )];

    if (sameDomainLinks.length === 0) {
      setStatus("No same-domain links found to crawl", "error");
      return;
    }

    const confirmed = confirm(
      `Found ${sameDomainLinks.length} page(s) on ${baseHost}:\n\n` +
      sameDomainLinks.map((u, i) => `${i + 1}. ${new URL(u).pathname}`).join("\n") +
      "\n\nFetch and package all into one ZIP?"
    );
    if (!confirmed) return;

    setStatus("Crawling funnel pages...", "grabbing");
    setProgress(5);

    const zip = new JSZip();

    const addPage = async (url, slug) => {
      const resp = await new Promise(resolve =>
        chrome.runtime.sendMessage({ action: "fetchUrl", url }, r => resolve(r || { success: false }))
      );
      if (!resp.success) return;
      const parsed = parseHtmlToData(resp.content, url);
      zip.file(`${slug}/index.html`, resp.content);
      return parsed;
    };

    const rootSlug = base.pathname.replace(/\//g, "-").replace(/^-/, "") || "home";
    zip.file(`${rootSlug}/index.html`, projectData.fullHtml || "");
    setProgress(15);

    for (let i = 0; i < sameDomainLinks.length; i++) {
      const url = sameDomainLinks[i];
      const slug = new URL(url).pathname.replace(/\//g, "-").replace(/^-|-$/g, "") || `page-${i}`;
      setStatus(`Fetching page ${i + 1}/${sameDomainLinks.length}: /${slug}`, "grabbing");
      await addPage(url, slug);
      setProgress(15 + Math.round(((i + 1) / sameDomainLinks.length) * 70));
    }

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${[projectData.pageUrl, ...sameDomainLinks].map(u => `<url><loc>${u}</loc></url>`).join("\n  ")}
</urlset>`;
    zip.file("sitemap.xml", sitemap);
    zip.file("README.md", `# Funnel Crawl\nCrawled ${sameDomainLinks.length + 1} pages from ${baseHost}\nDate: ${new Date().toISOString()}\n\nPages:\n${[projectData.pageUrl, ...sameDomainLinks].map(u => `- ${u}`).join("\n")}`);

    setStatus("Compressing...", "grabbing");
    setProgress(90);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `funnel-${baseHost}-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);

    setProgress(100);
    setStatus(`✅ Funnel crawled — ${sameDomainLinks.length + 1} pages packaged`, "done");

  } catch (err) {
    setStatus("Crawl failed: " + err.message, "error");
    console.error("[Keep My GHL] Crawl error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "🕸️ Crawl Entire Funnel";
  }
}

// ── Panel + section toggle helpers ───────────────────────
function initSectionToggles() {
  document.getElementById("toggleTools").addEventListener("click", function () {
    this.classList.toggle("open");
    document.getElementById("toolsPanel").classList.toggle("show");
  });
  document.getElementById("toggleSnapshots").addEventListener("click", function () {
    this.classList.toggle("open");
    document.getElementById("snapshotPanel").classList.toggle("show");
    if (document.getElementById("snapshotPanel").classList.contains("show")) loadSnapshots();
  });

  document.getElementById("autoBackupToggle").addEventListener("click", toggleAutoBackup);

  document.querySelectorAll(".pill").forEach(p => {
    p.addEventListener("click", () => setSchedule(parseInt(p.dataset.h)));
  });

  document.getElementById("auditClose").addEventListener("click", () =>
    document.getElementById("auditPanel").classList.remove("show"));
  document.getElementById("brandClose").addEventListener("click", () =>
    document.getElementById("brandPanel").classList.remove("show"));
  document.getElementById("complianceClose").addEventListener("click", () =>
    document.getElementById("compliancePanel").classList.remove("show"));

  document.getElementById("brandExport").addEventListener("click", exportBrandKit);
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    document.getElementById("currentUrl").textContent = tab.url;
  } catch {
    document.getElementById("currentUrl").textContent = "Unable to detect";
  }

  document.getElementById("btnGrab").addEventListener("click", grabProject);
  document.getElementById("btnDownload").addEventListener("click", downloadZip);
  document.getElementById("btnGitHub").addEventListener("click", pushToGitHub);
  document.getElementById("btnNetlify").addEventListener("click", deployToNetlify);
  document.getElementById("btnVercel").addEventListener("click", deployToVercel);
  document.getElementById("btnGHPages").addEventListener("click", deployToGHPages);
  document.getElementById("btnCloudflare").addEventListener("click", deployToCloudflare);
  document.getElementById("btnSchemas").addEventListener("click", previewSchemas);
  document.getElementById("btnSource").addEventListener("click", exportSourceCode);
  document.getElementById("btnSEOAudit").addEventListener("click", runSEOAudit);
  document.getElementById("btnBrandKit").addEventListener("click", extractBrandKit);
  document.getElementById("btnGDPR").addEventListener("click", runGDPRCheck);
  document.getElementById("btnScrub").addEventListener("click", scrubTrackingScripts);
  document.getElementById("btnCrawl").addEventListener("click", crawlFunnel);

  initSectionToggles();
  initAutoBackup();
});
