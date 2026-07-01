// shared-asset-collector.js — the ONE asset-collection implementation.
// Used by content.js (single-frame capture) and crawler.js (multi-page crawl, added in a later task).
// Do not fork this logic again — that's exactly how bug #2 (missing assets
// during multi-page crawl) happened the first time.
function collectPageAssets(doc) {
  const result = { stylesheets: [], scripts: [], images: [], fonts: [] };
  const seenImgSrcs = new Set();

  // ── Stylesheets ──────────────────────────────────────────
  doc.querySelectorAll("style").forEach((s) => {
    if (s.textContent.trim()) {
      result.stylesheets.push({ url: null, content: s.textContent, type: "inline" });
    }
  });
  for (const sheet of doc.styleSheets) {
    try {
      const rules = Array.from(sheet.cssRules || []).map((r) => r.cssText).join("\n");
      if (rules.trim()) {
        result.stylesheets.push({ url: sheet.href || null, content: rules, type: "external" });
      }
    } catch {
      if (sheet.href) result.stylesheets.push({ url: sheet.href, content: null, type: "cross-origin" });
    }
  }
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    if (link.href && !result.stylesheets.some((s) => s.url === link.href)) {
      result.stylesheets.push({ url: link.href, content: null, type: "external-url" });
    }
  });

  // ── Scripts ──────────────────────────────────────────────
  doc.querySelectorAll("script").forEach((s) => {
    if (s.type === "application/ld+json") return;
    if (s.src) {
      if (!result.scripts.some((x) => x.url === s.src)) {
        result.scripts.push({ url: s.src, content: null, type: "external" });
      }
    } else if (s.textContent.trim()) {
      result.scripts.push({ url: null, content: s.textContent, type: "inline" });
    }
  });

  // ── Images (incl. lazy-src, computed-style backgrounds, SVGs) ──
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.src || img.dataset.src || img.getAttribute("data-lazy-src") || img.getAttribute("data-src") || "";
    if (src && !seenImgSrcs.has(src)) {
      seenImgSrcs.add(src);
      result.images.push({
        src, alt: img.alt || "",
        width: img.naturalWidth || img.width || null,
        height: img.naturalHeight || img.height || null,
        loading: img.loading || "eager",
      });
    }
  });
  doc.querySelectorAll("*").forEach((el) => {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none" && bg.includes("url(")) {
        const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (match && match[1] && !seenImgSrcs.has(match[1])) {
          seenImgSrcs.add(match[1]);
          result.images.push({ src: match[1], alt: "background-image", width: null, height: null, loading: "eager" });
        }
      }
    } catch {}
  });
  doc.querySelectorAll("svg").forEach((svg, i) => {
    const key = "svg-" + i;
    if (!seenImgSrcs.has(key)) {
      seenImgSrcs.add(key);
      result.images.push({ src: key, alt: svg.getAttribute("aria-label") || "svg", width: null, height: null, svgContent: svg.outerHTML });
    }
  });

  // ── Fonts (link href + @font-face rules) ────────────────
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    if (link.href && (link.href.includes("fonts.googleapis") || link.href.includes("font"))) {
      result.fonts.push({ url: link.href, type: "google-fonts" });
    }
  });
  for (const sheet of doc.styleSheets) {
    try {
      for (const rule of sheet.cssRules || []) {
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          result.fonts.push({
            family: rule.style.getPropertyValue("font-family"),
            src: rule.style.getPropertyValue("src"),
            type: "font-face",
          });
        }
      }
    } catch {}
  }

  return result;
}
