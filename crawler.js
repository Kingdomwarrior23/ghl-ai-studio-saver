// FreeMyGHL — crawler.js
// Injected into the GHL AI Studio PREVIEW iframe (vibepreview.com) as a real
// file via chrome.scripting.executeScript({ files: [...] }, world: "MAIN").
// Crawls all React Router routes by using pushState navigation — no page reloads.
// Each route is captured after React re-renders (MutationObserver stable check).
// Asset collection is delegated to the shared collector (shared-asset-collector.js,
// injected alongside this file in the same MAIN-world context) so multi-page
// crawls and single-page captures never fork asset logic again.
//
// CWS COMPLIANCE NOTE: unlike the older fork this was ported from, this file is
// never stringified and run via eval()/new Function(). It is injected as a real
// file (files: ["shared-asset-collector.js", "crawler.js"]) and its result is
// retrieved via a separate func: probe that reads window.__fmghlCrawlResult —
// see popup.js. Manifest V3 / Chrome Web Store policy forbids executing a
// string as code; file-based injection is the sanctioned alternative.

(async function fmghlCrawl() {

  // ── Discover all internal routes from anchor links ──────────────────────
  function collectRoutes() {
    const origin = window.location.origin;
    const seen = new Set(["/"]);
    document.querySelectorAll("a[href]").forEach(a => {
      try {
        const url = new URL(a.href, origin);
        if (url.origin !== origin) return;
        const path = url.pathname;
        if (!path || path === "#") return;
        seen.add(path);
      } catch {}
    });
    return [...seen].sort();
  }

  // ── Wait for React to finish rendering after route change ───────────────
  function waitStable(ms = 600, timeout = 5000) {
    return new Promise(resolve => {
      let timer = null;
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => { obs.disconnect(); resolve(); }, ms);
      });
      obs.observe(document.getElementById("root") || document.body, {
        childList: true, subtree: true
      });
      // Start stability timer immediately
      timer = setTimeout(() => { obs.disconnect(); resolve(); }, ms);
      // Hard cap
      setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
    });
  }

  // ── Navigate to a route via React Router (no page reload) ───────────────
  async function navigateTo(path) {
    window.history.pushState(null, "", path);
    // Fire popstate so React Router picks it up
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    // Also fire hashchange as fallback for hash routers
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitStable();
  }

  // ── Clean HTML for export ───────────────────────────────────────────────
  function cleanHtml(html, route) {
    // ── keep existing strips ──────────────────────────────────────────────
    html = html.replace(/<script[^>]*\/__vibe\/[^>]*><\/script>/g, "");
    html = html.replace(/<script[^>]*vibepreview[^>]*handler[^>]*><\/script>/g, "");
    html = html.replace(/<meta[^>]*noindex[^>]*>/gi, "");
    html = html.replace(/<script[^>]*cdn\.tailwindcss\.com[^>]*><\/script>/g, "");

    // ── Strip GHL preview mode overlay elements ──────────────────────────
    html = html.replace(/<div[^>]*id="vibe-preview-[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
    html = html.replace(/<div[^>]*class="[^"]*vibe-preview[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");
    html = html.replace(/<div[^>]*data-vibe-preview[^>]*>[\s\S]*?<\/div>/gi, "");

    // ── strip GHL Vibe builder editor overlay (must never appear in export) ──
    html = html.replace(/<style[^>]*id="vibe-selector-styles"[^>]*>[\s\S]*?<\/style>/gi, "");
    html = html.replace(/\s+data-vb-(?:hovered|selected|primary|full-width)(?:="[^"]*")?/gi, "");
    html = html.replace(/<script[^>]*data-tailwind-jit[^>]*><\/script>/gi, "");
    html = html.replace(/<div[^>]*class="gpt-selected-tooltip[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "");

    // ── close open dialogs/modals captured mid-state ─────────────────
    html = html.replace(/<dialog(\s[^>]*)?\sopen([\s>])/gi, "<dialog$1$2");
    html = html.replace(
      /(<[^>]*aria-modal="true"[^>]*style=")([^"]*display\s*:\s*(block|flex)[^"]*")/gi,
      (m, pre, style) => pre + style.replace(/display\s*:\s*(block|flex)/i, "display:none")
    );

    // ── inject DOM cleanup script ────────────────────────────────────
    const CLEANUP = `<script>
(function(){
  // Strip GHL builder editor attributes
  document.querySelectorAll("[data-vb-hovered],[data-vb-selected],[data-vb-primary]")
    .forEach(el => ["data-vb-hovered","data-vb-selected","data-vb-primary","data-vb-full-width"]
      .forEach(a => el.removeAttribute(a)));
  // Remove vibe editor styles if still present
  var vbs = document.getElementById("vibe-selector-styles");
  if (vbs) vbs.remove();
  // Close any open dialogs
  document.querySelectorAll("dialog[open]").forEach(d => {
    try { d.close(); } catch(e) { d.removeAttribute("open"); }
  });
  // Unfreeze body scroll (modals set overflow:hidden on body)
  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
  // Remove fixed-position high-z-index overlays (backdrop, modal overlay divs)
  document.querySelectorAll("*").forEach(el => {
    var s = window.getComputedStyle(el);
    if (s.position === "fixed" && parseInt(s.zIndex) > 100) {
      var tag = el.tagName.toLowerCase();
      // Don't remove nav bars or legitimate fixed UI — only overlays/backdrops
      if (el.getAttribute("role") === "dialog" ||
          (el.className && /(overlay|backdrop|modal)/i.test(el.className)) ||
          (s.backgroundColor.includes("rgba") && s.inset === "0px")) {
        el.remove();
      }
    }
  });
  // Legacy selectors (vibe-preview bar, cookie banners)
  var selectors = [
    '[id*="vibe-preview"]','[class*="vibe-preview"]','[data-vibe-preview]',
    '[id*="preview-bar"]','[id*="preview-banner"]','[class*="preview-banner"]',
    '[id*="cookie"]','[class*="cookie-banner"]','[class*="cookie-consent"]',
    '[id*="gdpr"]','[class*="gdpr"]'
  ];
  selectors.forEach(function(s){
    document.querySelectorAll(s).forEach(function(el){ el.remove(); });
  });
  // Remove backdrop blur baked into body
  document.body.style.filter = '';
  document.body.style.backdropFilter = '';
})();
<\/script>`;

    html = html.replace("</body>", CLEANUP + "\n</body>");

    // ── keep existing rewrites ────────────────────────────────────────────
    const previewOrigin = window.location.origin;
    html = html.split(previewOrigin).join("");
    if (!html.includes("<base ")) {
      html = html.replace("<head>", '<head>\n<base href="/">');
    }
    return html;
  }

  // ── Merge a page's collectPageAssets() result into the running total ────
  // collectPageAssets() shape: { stylesheets:[{url,content,type}], scripts:[{url,content,type}],
  // images:[{src,...}], fonts:[{url|family,...}] } — same shape content.js uses,
  // so this merges cleanly into projectData.stylesheets/.scripts/.images/.fonts
  // downstream in popup.js's ZIP builder.
  function mergeAssets(target, pageAssets) {
    const dedupeKey = (item, listName) => {
      if (listName === "images") return item.src;
      if (listName === "fonts") return item.url || item.family;
      return item.url || item.content;
    };
    Object.keys(target).forEach(listName => {
      const seen = new Set(target[listName].map(item => dedupeKey(item, listName)));
      (pageAssets[listName] || []).forEach(item => {
        const key = dedupeKey(item, listName);
        if (key && seen.has(key)) return;
        if (key) seen.add(key);
        target[listName].push(item);
      });
    });
  }

  // ── Main crawl ───────────────────────────────────────────────────────────
  const startRoute = window.location.pathname;
  const pages = [];
  const allAssets = { stylesheets: [], scripts: [], images: [], fonts: [] };

  // Collect routes from home page first
  const routes = collectRoutes();

  for (const route of routes) {
    try {
      if (route !== startRoute) {
        await navigateTo(route);
      } else {
        await waitStable(400, 3000);
      }

      const html = cleanHtml(document.documentElement.outerHTML, route);
      const title = document.title;
      const assets = collectPageAssets(document);
      const slug = route === "/" ? "index" : route.replace(/^\//, "").replace(/\//g, "-");

      pages.push({ route, slug, html, title });

      mergeAssets(allAssets, assets);

      // Signal progress to popup via storage
      try {
        chrome.storage.local.set({
          __fmghl_crawl_progress: { done: pages.length, total: routes.length, current: route }
        });
      } catch {}

    } catch (e) {
      console.warn("[FreeMyGHL] Failed to capture route:", route, e.message);
    }
  }

  // Navigate back to home
  try { await navigateTo("/"); } catch {}

  const result = { pages, assets: allAssets, projectId: window.__fmghlProjectId || null };
  window.__fmghlCrawlResult = result;
  return result;

})();
