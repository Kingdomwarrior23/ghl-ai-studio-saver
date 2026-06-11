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
    }
    return true;
  };

  window.__ghlSaverHandler = handler;
  chrome.runtime.onMessage.addListener(handler);

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
    // Primary signal: URL path — Vibe builder is always at /v2/location/.../vibe/projects/...
    // Fallback: DOM attributes (may change across GHL releases).
    const isVibeBuilderShell = !!(
      window.location.pathname.includes("/vibe/projects/") ||
      doc.querySelector('[data-testid="builder-view"]') ||
      doc.querySelector('[data-testid="top-nav-bar"]') ||
      doc.querySelector('[data-v-b3a7a1a6]')
    );
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

    // ── 4. Stylesheets ───────────────────────────────────
    data.stylesheets = [];

    // Inline <style> tags
    doc.querySelectorAll("style").forEach((s) => {
      if (s.textContent.trim()) {
        data.stylesheets.push({ url: null, content: s.textContent, type: "inline" });
      }
    });

    // External stylesheets via styleSheets API
    for (const sheet of doc.styleSheets) {
      try {
        const rules = Array.from(sheet.cssRules || [])
          .map((r) => r.cssText)
          .join("\n");
        if (rules.trim()) {
          data.stylesheets.push({ url: sheet.href || null, content: rules, type: "external" });
        }
      } catch {
        if (sheet.href) {
          data.stylesheets.push({ url: sheet.href, content: null, type: "cross-origin" });
        }
      }
    }

    // <link rel="stylesheet"> URLs
    doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      if (link.href && !data.stylesheets.some((s) => s.url === link.href)) {
        data.stylesheets.push({ url: link.href, content: null, type: "external-url" });
      }
    });
    data.cssCount = data.stylesheets.length;

    // ── 5. JavaScript ────────────────────────────────────
    data.scripts = [];
    doc.querySelectorAll("script").forEach((s) => {
      if (s.type === "application/ld+json") return;
      if (s.src) {
        if (!data.scripts.some((x) => x.url === s.src)) {
          data.scripts.push({ url: s.src, content: null, type: "external" });
        }
      } else if (s.textContent.trim()) {
        data.scripts.push({ url: null, content: s.textContent, type: "inline" });
      }
    });
    data.jsCount = data.scripts.length;

    // ── 6. Images ────────────────────────────────────────
    data.images = [];
    const seenImgSrcs = new Set();

    doc.querySelectorAll("img").forEach((img) => {
      const src = img.src || img.dataset.src || img.getAttribute("data-lazy-src") || img.getAttribute("data-src") || "";
      if (src && !seenImgSrcs.has(src)) {
        seenImgSrcs.add(src);
        data.images.push({
          src: src,
          alt: img.alt || "",
          width: img.naturalWidth || img.width || null,
          height: img.naturalHeight || img.height || null,
          loading: img.loading || "eager",
        });
      }
    });

    // Background images
    doc.querySelectorAll("*").forEach((el) => {
      try {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none" && bg.includes("url(")) {
          const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (match && match[1] && !seenImgSrcs.has(match[1])) {
            seenImgSrcs.add(match[1]);
            data.images.push({ src: match[1], alt: "background-image", width: null, height: null, loading: "eager" });
          }
        }
      } catch {}
    });

    // SVGs
    doc.querySelectorAll("svg").forEach((svg, i) => {
      const key = "svg-" + i;
      if (!seenImgSrcs.has(key)) {
        seenImgSrcs.add(key);
        data.images.push({ src: key, alt: svg.getAttribute("aria-label") || "svg", width: null, height: null, svgContent: svg.outerHTML });
      }
    });
    data.imageCount = data.images.length;

    // ── 7. Fonts ─────────────────────────────────────────
    data.fonts = [];
    doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      if (link.href && (link.href.includes("fonts.googleapis") || link.href.includes("font"))) {
        data.fonts.push({ url: link.href, type: "google-fonts" });
      }
    });
    for (const sheet of doc.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule.type === CSSRule.FONT_FACE_RULE) {
            const src = rule.style.getPropertyValue("src");
            const family = rule.style.getPropertyValue("font-family");
            data.fonts.push({ family, src, type: "font-face" });
          }
        }
      } catch {}
    }
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
