// GHL Project Saver — interceptor.js
// Injected at document_start in the MAIN world so it runs BEFORE GHL's code.
// Patches fetch + XHR to intercept the project file payload GHL loads into
// WebContainers. Stores captured files on window.__capturedSourceFiles.

(function () {
  if (window.__ghlInterceptorInstalled) return;
  window.__ghlInterceptorInstalled = true;

  // Only run on GHL AI Studio project pages
  const isStudioPage = () =>
    window.location.pathname.includes("/vibe/projects/") ||
    window.location.hostname.includes("gohighlevel.com") ||
    window.location.hostname.includes("leadconnectorhq.com");

  if (!isStudioPage()) return;

  console.log("[Free My GHL] Interceptor active — watching for project file payload");

  // ── Heuristic: does this JSON look like a project file tree? ──────────
  function extractFiles(data) {
    if (!data || typeof data !== "object") return null;

    // Shape A: { files: { "/src/App.tsx": "...", ... } }
    // Shape B: { data: { files: { ... } } }
    // Shape C: { files: [ { path, content }, ... ] }
    // Shape D: flat object where keys are file paths
    // Shape E: { project: { files: { ... } } }
    const candidates = [
      data.files,
      data.data?.files,
      data.project?.files,
      data.result?.files,
      data.payload?.files,
      data, // flat map
    ].filter(Boolean);

    for (const candidate of candidates) {
      // Array of {path, content} objects
      if (Array.isArray(candidate)) {
        const mapped = {};
        for (const item of candidate) {
          if (item && typeof item.path === "string" && typeof item.content === "string") {
            mapped[item.path] = item.content;
          }
        }
        if (Object.keys(mapped).length >= 2) return mapped;
      }

      // Object map — keys are file paths
      if (typeof candidate === "object" && !Array.isArray(candidate)) {
        const entries = Object.entries(candidate);
        // Must have at least 2 entries that look like source files
        const fileEntries = entries.filter(([k, v]) => {
          if (typeof k !== "string") return false;
          const ext = k.split(".").pop()?.toLowerCase();
          const isSourceExt = ["tsx", "ts", "jsx", "js", "css", "html", "json", "md", "svg", "env", "toml", "yaml", "yml"].includes(ext);
          const hasContent = typeof v === "string" && v.length > 0;
          const hasContentProp = v && typeof v === "object" && typeof v.content === "string";
          return isSourceExt && (hasContent || hasContentProp);
        });

        if (fileEntries.length >= 2) {
          const mapped = {};
          for (const [k, v] of fileEntries) {
            const path = k.startsWith("/") ? k : `/${k}`;
            mapped[path] = typeof v === "string" ? v : v.content;
          }
          return mapped;
        }
      }
    }
    return null;
  }

  function captureIfFiles(url, data) {
    if (!url) return;
    // Only care about GHL/Bolt/StackBlitz related endpoints
    const relevant =
      url.includes("vibe") ||
      url.includes("project") ||
      url.includes("bolt") ||
      url.includes("webcontainer") ||
      url.includes("studio") ||
      url.includes("files");
    if (!relevant) return;

    const files = extractFiles(data);
    if (!files) return;

    console.log(`[Free My GHL] ✅ Captured ${Object.keys(files).length} source files from: ${url}`);
    window.__capturedSourceFiles = files;
    window.__capturedSourceUrl = url;

    // Extract projectId from the URL if not already known
    if (!window.__capturedProjectId) {
      const m = window.location.pathname.match(/vibe\/projects\/(\w+)/) ||
                url.match(/projects?\/([a-zA-Z0-9_-]{8,})/);
      if (m) window.__capturedProjectId = m[1];
    }
  }

  // ── Patch fetch ───────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const req = args[0];
    const url = typeof req === "string" ? req : req?.url || "";
    const prom = _fetch.apply(this, args);
    prom.then(res => {
      const clone = res.clone();
      clone.json().then(data => captureIfFiles(url, data)).catch(() => {});
    }).catch(() => {});
    return prom;
  };

  // ── Patch XHR ─────────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ghlUrl = url;
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const data = JSON.parse(this.responseText);
        captureIfFiles(this.__ghlUrl || "", data);
      } catch {}
    });
    return _send.apply(this, args);
  };

  // ── Also watch postMessage — WebContainers uses it to communicate ──────
  // The GHL shell might receive file data from the WC iframe via message
  window.addEventListener("message", (event) => {
    try {
      const d = event.data;
      if (!d || typeof d !== "object") return;
      // Look for bolt/WC style file payloads
      if (d.type === "bolt:files" || d.type === "wc:files" || d.type === "project:files") {
        const files = extractFiles(d.payload || d.files || d.data || d);
        if (files) {
          console.log(`[Free My GHL] ✅ Captured ${Object.keys(files).length} files via postMessage (${d.type})`);
          window.__capturedSourceFiles = files;
        }
      }
      // Generic: any message with a files-looking payload
      if (!window.__capturedSourceFiles) {
        const files = extractFiles(d);
        if (files) {
          console.log(`[Free My GHL] ✅ Captured ${Object.keys(files).length} files via postMessage`);
          window.__capturedSourceFiles = files;
        }
      }
    } catch {}
  }, true); // capture phase so we see it before GHL

})();
