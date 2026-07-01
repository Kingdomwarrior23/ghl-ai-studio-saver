// GHL Project Saver — content.js
// Runs in BOTH the main GHL page AND the vibe iframe (via all_frames).
// When inside the iframe, it captures the actual page content.
// When in the main frame, it captures whatever is accessible.

(function () {
  // Remove old listener if re-injecting
  if (window.__ghlSaverInjected) {
    chrome.runtime.onMessage.removeListener(window.__ghlSaverHandler);
  }
  window.__ghlSaverInjected = true;

  // Detect which frame we're in
  const isIframe = window.top !== window;
  const frameInfo = isIframe
    ? `iframe (${window.location.hostname})`
    : "main frame";

  console.log(`[GHL Saver] Content script running in: ${frameInfo}`);

  const handler = (msg, sender, sendResponse) => {
    if (msg.action === "grabProject") {
      try {
        const data = extractEverything();
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    } else if (msg.action === "collectRoutes") {
      try {
        const routes = collectSameOriginRoutes();
        sendResponse({ success: true, routes });
      } catch (err) {
        sendResponse({ success: false, error: err.message, routes: [] });
      }
    }
    return true;
  };

  window.__ghlSaverHandler = handler;
  chrome.runtime.onMessage.addListener(handler);

  // Standalone same-origin anchor scan for legacy (non-SPA) GHL builder pages.
  // Used to discover routes to crawl via tab-based orchestration in popup.js,
  // since legacy funnel/website/blog pages are real multi-page sites, not an
  // SPA that crawler.js's client-side route driver can walk.
  function collectSameOriginRoutes() {
    const origin = window.location.origin;
    // Normalize trailing slashes so "/pricing" and "/pricing/" aren't treated
    // as two different routes — strip a single trailing slash except when the
    // pathname IS just "/".
    const normalizePath = (path) => (path.length > 1 ? path.replace(/\/$/, "") : path);
    const seen = new Set([normalizePath(window.location.pathname)]);
    document.querySelectorAll("a[href]").forEach((a) => {
      try {
        const url = new URL(a.href, origin);
        if (url.origin !== origin) return;
        if (!url.pathname || url.pathname === "#") return;
        seen.add(normalizePath(url.pathname));
      } catch {}
    });
    return [...seen].sort();
  }

  function extractEverything() {
    const data = {};
    const doc = document;

    // ── Frame identity ────────────────────────────────────
    data.frameSource = frameInfo;
    data.isIframe = isIframe;
    data.hostname = window.location.hostname;
    data.frameUrl = window.location.href;

    // Score this frame's content quality (higher = more likely the real page)
    const bodyHTML = doc.body ? doc.body.innerHTML : "";
    const bodyLen = bodyHTML.length;
    const hasSections = doc.querySelectorAll('[class*="section"], [class*="cblock"], [class*="el-"], [class*="gh-"], [id*="section"]').length;
    const hasImages = doc.querySelectorAll("img").length;
    const hasHeadings = doc.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
    const hasNav = doc.querySelectorAll("nav, [class*='nav']").length;

    // Parentheses required — ternary has lower precedence than + so without them
    // the bonus terms only apply in the else branch (bodyLen <= 1000), never in practice.
    data.contentScore = (bodyLen > 1000 ? bodyLen / 1000 : 0)
      + hasSections * 5
      + hasImages * 3
      + hasHeadings * 2
      + hasNav * 2;

    // Detect and hard-penalize the GHL Vibe builder shell.
    // Primary signal: URL path (reliable — Vibe builder is always at this path).
    // Secondary: require >=2 DOM markers together, not just 1, so a single
    // transiently-rendered marker during preview-frame load can't misfire.
    const urlSaysShell = window.location.pathname.includes("/vibe/projects/");
    const domMarkers = [
      !!doc.querySelector('[data-testid="builder-view"]'),
      !!doc.querySelector('[data-testid="top-nav-bar"]'),
      !!doc.querySelector('[data-v-b3a7a1a6]'),
    ];
    const domMarkerCount = domMarkers.filter(Boolean).length;
    const isVibeBuilderShell = urlSaysShell || domMarkerCount >= 2;
    if (isVibeBuilderShell) {
      data.contentScore = -999;
      // Find the preview iframe URL so popup can fetch it directly as a fallback
      const allIframes = Array.from(doc.querySelectorAll("iframe"));
      const previewFrame = allIframes.find((f) => {
        if (!f.src || f.src.length < 10) return false;
        if (f.src.startsWith("about:") || f.src.startsWith("javascript:") || f.src.startsWith("blob:")) return false;
        const h = new URL(f.src).hostname;
        // Exclude GHL app domains and common third-party embeds
        if (h.includes("gohighlevel.com") || h.includes("leadconnectorhq.com")) return false;
        if (h.includes("googleapis.com") || h.includes("google.com") || h.includes("youtube.com")) return false;
        if (h.includes("intercom") || h.includes("stripe.com") || h.includes("hotjar")) return false;
        return true;
      });
      data.previewIframeUrl = previewFrame ? previewFrame.src : null;
      if (data.previewIframeUrl) {
        console.log("[GHL Saver] Builder shell found preview iframe:", data.previewIframeUrl);
      }
    }

    // Legacy funnel/website/blog builder shell (distinct editor UI from Vibe).
    // Reliable URL signal: legacy builder pages live at /v2/location/.../funnels-builder/...
    // or /v2/location/.../websites-builder/... or /v2/location/.../blogs-builder/...
    // NOTE: this exact URL pattern is NOT confirmed against a live GHL account —
    // it's a best-guess from GHL's naming conventions. Flagged explicitly in the
    // plan as needing verification against a real account before being trusted.
    const isLegacyBuilderShell = /\/(funnels|websites|blogs)-builder\//.test(window.location.pathname);
    if (isLegacyBuilderShell) {
      data.contentScore = -999;
      data.isLegacyBuilderShell = true;
      // Legacy builder renders the real page inside a same-origin iframe
      // (unlike Vibe's cross-origin vibepreview.com) — find it the same way.
      const allIframes = Array.from(doc.querySelectorAll("iframe"));
      const previewFrame = allIframes.find((f) => f.src && f.src.length > 10 && !f.src.startsWith("about:"));
      data.previewIframeUrl = previewFrame ? previewFrame.src : null;
    }

    // ── 1. Full rendered HTML ────────────────────────────
    data.fullHtml = doc.documentElement.outerHTML;
    data.pageTitle = doc.title || "";
    data.htmlCount = 1;

    // ── 2. JSON-LD Schemas ───────────────────────────────
    data.schemas = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const raw = JSON.parse(script.textContent);
        if (raw["@graph"]) {
          raw["@graph"].forEach((item) => {
            const type = item["@type"] || "GraphItem";
            const preview = Object.keys(item)
              .slice(0, 5)
              .map((k) => `${k}: ${String(item[k]).substring(0, 40)}`)
              .join(", ");
            data.schemas.push({ type, raw: item, preview });
          });
        } else {
          const type = raw["@type"] || "Unknown";
          const preview = Object.keys(raw)
            .slice(0, 5)
            .map((k) => `${k}: ${String(raw[k]).substring(0, 40)}`)
            .join(", ");
          data.schemas.push({ type, raw, preview });
        }
      } catch {
        data.schemas.push({
          type: "MALFORMED",
          raw: script.textContent,
          preview: script.textContent.substring(0, 80),
        });
      }
    });
    data.schemaCount = data.schemas.length;

    // ── 3. Meta Tags ─────────────────────────────────────
    data.metaTags = { meta: [], og: [], twitter: [], other: [] };
    doc.querySelectorAll("meta").forEach((m) => {
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
    data.metaTags.canonical = canonical ? canonical.href : null;
    const viewport = doc.querySelector('meta[name="viewport"]');
    data.metaTags.viewport = viewport ? viewport.content : null;

    // ── 4-7. Assets (stylesheets, scripts, images, fonts) ────
    // Delegated to shared-asset-collector.js so content.js and crawler.js
    // never diverge on what counts as "an asset" again.
    const assets = collectPageAssets(doc);
    data.stylesheets = assets.stylesheets;
    data.cssCount = data.stylesheets.length;
    data.scripts = assets.scripts;
    data.jsCount = data.scripts.length;
    data.images = assets.images;
    data.imageCount = data.images.length;
    data.fonts = assets.fonts;
    data.fontCount = data.fonts.length;

    // ── 8. GHL Section Structure ─────────────────────────
    data.ghlStructure = [];
    doc.querySelectorAll(
      '[class*="section"], [class*="cblock"], [id*="section"], [class*="el-"], [class*="gh-"], [class*="row"], [class*="column"], [class*="element"]'
    ).forEach((el) => {
      data.ghlStructure.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: el.className?.toString().substring(0, 200) || "",
        childCount: el.children.length,
        textPreview: el.textContent?.trim().substring(0, 100) || "",
      });
    });

    // ── 9. Links ─────────────────────────────────────────
    data.links = [];
    doc.querySelectorAll("a[href]").forEach((a) => {
      if (a.href && !a.href.startsWith("javascript:")) {
        data.links.push({ href: a.href, text: a.textContent.trim().substring(0, 100), target: a.target || "" });
      }
    });

    // ── 10. Total ────────────────────────────────────────
    data.totalAssets =
      data.cssCount + data.jsCount + data.imageCount + data.fontCount + data.schemaCount + data.links.length;

    return data;
  }
})();
