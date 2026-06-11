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

    setProgress(90);
    showResults(projectData);
    showSchemas(projectData.schemas);

    document.getElementById("btnDownload").disabled = false;
    document.getElementById("btnSchemas").disabled = false;
    document.getElementById("btnGitHub").disabled = false;

    setStatus("Done! " + projectData.totalAssets + " assets captured", "done");
    setProgress(100);
  } catch (err) {
    setStatus("Error: " + err.message, "error");
    console.error("GHL Saver error:", err);
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 Grab Full Project";
  }
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

    // index.html — the full rendered page
    root.file("index.html", projectData.fullHtml);

    // schemas
    if (projectData.schemas && projectData.schemas.length) {
      const schemaDir = root.folder("schemas");
      projectData.schemas.forEach((s, i) => {
        schemaDir.file(`schema-${i + 1}-${s.type.toLowerCase()}.json`, JSON.stringify(s.raw, null, 2));
      });
      // Combined paste-ready file
      const combined = projectData.schemas
        .map((s) => `<script type="application/ld+json">\n${JSON.stringify(s.raw, null, 2)}\n</script>`)
        .join("\n\n");
      schemaDir.file("ALL-SCHEMAS-PASTE.txt", combined);
    }

    // meta.json — all meta/OG/Twitter tags
    root.file("meta.json", JSON.stringify(projectData.metaTags, null, 2));

    // stylesheets
    if (projectData.stylesheets && projectData.stylesheets.length) {
      const cssDir = root.folder("css");
      projectData.stylesheets.forEach((s, i) => {
        const name = s.url ? s.url.split("/").pop().split("?")[0] || `style-${i}.css` : `inline-${i}.css`;
        cssDir.file(name, s.content || "/* external: " + (s.url || "unknown") + " */");
      });
    }

    // scripts
    if (projectData.scripts && projectData.scripts.length) {
      const jsDir = root.folder("js");
      projectData.scripts.forEach((s, i) => {
        const name = s.url ? s.url.split("/").pop().split("?")[0] || `script-${i}.js` : `inline-${i}.js`;
        jsDir.file(name, s.content || "/* external: " + (s.url || "unknown") + " */");
      });
    }

    // images (as URLs list + any base64 we captured)
    if (projectData.images && projectData.images.length) {
      const imgDir = root.folder("images");
      const imgList = projectData.images.map((img) => ({
        src: img.src,
        alt: img.alt,
        width: img.width,
        height: img.height,
      }));
      imgDir.file("image-urls.json", JSON.stringify(imgList, null, 2));
    }

    // GHL component structure
    if (projectData.ghlStructure && projectData.ghlStructure.length > 0) {
      root.file("ghl-structure.json", JSON.stringify(projectData.ghlStructure, null, 2));
    }

    // asset manifest
    root.file(
      "manifest.json",
      JSON.stringify(
        {
          url: projectData.pageUrl,
          grabbedAt: projectData.grabbedAt,
          title: projectData.pageTitle,
          htmlCount: projectData.htmlCount,
          cssCount: projectData.cssCount,
          jsCount: projectData.jsCount,
          imageCount: projectData.imageCount,
          schemaCount: projectData.schemaCount,
          totalAssets: projectData.totalAssets,
        },
        null,
        2
      )
    );

    // README
    root.file(
      "README.md",
      `# GHL Project Export
**Source:** ${projectData.pageUrl}
**Grabbed:** ${projectData.grabbedAt}
**Title:** ${projectData.pageTitle}

## Contents
- \`index.html\` — Full rendered page source (with all dynamic content)
- \`schemas/\` — JSON-LD structured data (individual + paste-ready)
- \`meta.json\` — All meta, OG, and Twitter card tags
- \`css/\` — Stylesheets
- \`js/\` — JavaScript files
- \`images/\` — Image manifest with URLs and alt text
- \`manifest.json\` — Export metadata

## Schema Summary
${projectData.schemas ? projectData.schemas.map((s) => `- @${s.type}`).join("\n") : "No schemas found"}

## Quick Use
1. Open \`index.html\` to see the full page
2. Check \`schemas/\` for structured data
3. Paste schemas into GHL Custom Code if missing
`
    );

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ghl-project-" + Date.now() + ".zip";
    a.click();
    URL.revokeObjectURL(url);

    setStatus("ZIP downloaded!", "done");
  } catch (err) {
    setStatus("ZIP error: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 Download ZIP";
  }
}

// ── GitHub Push ──────────────────────────────────────────
async function pushToGitHub() {
  if (!projectData) return;

  // Get GitHub token from storage
  const { githubToken, githubRepo } = await chrome.storage.local.get(["githubToken", "githubRepo"]);

  if (!githubToken) {
    const token = prompt("Enter your GitHub Personal Access Token:");
    if (!token) return;
    const repo = prompt("Enter repo (e.g. username/repo-name):", "mitchellcgutters-site");
    if (!repo) return;
    await chrome.storage.local.set({ githubToken: token, githubRepo: repo });
    return pushToGitHub(); // Retry with saved token
  }

  let repo = githubRepo || prompt("Enter repo (e.g. username/repo-name):");
  if (!repo) return;

  // Auto-resolve: if repo is just a name (no slash), fetch the username
  if (!repo.includes("/")) {
    setStatus("Looking up GitHub username...", "grabbing");
    const userResp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${githubToken}`, Accept: "application/vnd.github.v3+json" },
    });
    if (userResp.ok) {
      const userInfo = await userResp.json();
      repo = `${userInfo.login}/${repo}`;
      // Save the full path for next time
      await chrome.storage.local.set({ githubRepo: repo });
    }
  }

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
    // Build all files to push
    const files = [
      { path: "index.html", content: projectData.fullHtml },
      { path: "meta.json", content: JSON.stringify(projectData.metaTags, null, 2) },
      { path: "manifest.json", content: JSON.stringify({ url: projectData.pageUrl, grabbedAt: projectData.grabbedAt, title: projectData.pageTitle }, null, 2) },
    ];
    if (projectData.schemas) {
      projectData.schemas.forEach((s, i) => {
        files.push({
          path: `schemas/schema-${i + 1}-${s.type.toLowerCase()}.json`,
          content: JSON.stringify(s.raw, null, 2),
        });
      });
    }
    if (projectData.ghlStructure && projectData.ghlStructure.length > 0) {
      files.push({ path: "ghl-structure.json", content: JSON.stringify(projectData.ghlStructure, null, 2) });
    }

    setProgress(10);

    // ── Detect if repo is empty (no branches yet) ──
    let isEmptyRepo = false;
    let defaultBranch = "main";
    // ── Check if repo exists; auto-create if not ──
    let repoResp = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoResp.ok && repoResp.status === 404) {
      // Repo doesn't exist — create it automatically
      setStatus("Creating repo on GitHub...", "grabbing");
      const repoName = repo.split("/").pop();
      const createResp = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: repoName,
          description: `Auto-created by GHL Saver — ${projectData.pageTitle || repoName}`,
          private: false,
          auto_init: false,
        }),
      });
      if (!createResp.ok) {
        const err = await createResp.json();
        throw new Error(`Failed to create repo "${repo}": ${err.message}. Create it manually on GitHub first.`);
      }
      setStatus("Repo created!", "done");
      // Re-fetch repo info
      repoResp = await fetch(`https://api.github.com/repos/${repo}`, { headers });
      if (!repoResp.ok) throw new Error("Repo was created but can't be read back.");
    } else if (!repoResp.ok) {
      const err = await repoResp.json();
      throw new Error(`GitHub API error (${repoResp.status}): ${err.message}`);
    }
    const repoInfo = await repoResp.json();
    defaultBranch = repoInfo.default_branch || "main";
    isEmptyRepo = !repoInfo.default_branch;

    setProgress(15);

    if (isEmptyRepo) {
      // ── EMPTY REPO: Use Git Data API (tree → commit → ref) ──
      setStatus("Empty repo — creating initial commit...", "grabbing");

      // Build tree entries
      const tree = files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content,
      }));

      // Create tree
      const treeResp = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tree }),
      });
      if (!treeResp.ok) {
        const err = await treeResp.json();
        throw new Error("Failed to create tree: " + (err.message || JSON.stringify(err)));
      }
      const treeData = await treeResp.json();

      setProgress(40);

      // Create commit (no parent — first commit)
      const commitResp = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: `GHL Saver: initial export of ${projectData.pageTitle || "project"}`,
          tree: treeData.sha,
        }),
      });
      if (!commitResp.ok) {
        const err = await commitResp.json();
        throw new Error("Failed to create commit: " + (err.message || JSON.stringify(err)));
      }
      const commitData = await commitResp.json();

      setProgress(70);

      // Create branch ref
      const refResp = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: `refs/heads/${defaultBranch}`,
          sha: commitData.sha,
        }),
      });
      if (!refResp.ok) {
        const err = await refResp.json();
        throw new Error("Failed to create branch: " + (err.message || JSON.stringify(err)));
      }

      setProgress(100);
      setStatus(`Pushed ${files.length} files to ${repo} (initial commit)`, "done");

    } else {
      // ── EXISTING REPO: Use Contents API (one file at a time) ──
      setStatus(`Pushing to ${defaultBranch}...`, "grabbing");
      let pushed = 0;

      for (const file of files) {
        // Check if file already exists (need SHA for update)
        let sha = null;
        const checkResp = await fetch(
          `https://api.github.com/repos/${repo}/contents/${file.path}?ref=${defaultBranch}`,
          { headers }
        );
        if (checkResp.ok) {
          const existing = await checkResp.json();
          sha = existing.sha;
        }

        const body = {
          message: sha
            ? `GHL Saver: update ${file.path}`
            : `GHL Saver: add ${file.path}`,
          content: btoa(unescape(encodeURIComponent(file.content))),
          branch: defaultBranch,
          ...(sha && { sha }),
        };

        const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${file.path}`, {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(`Failed to push ${file.path}: ${err.message}`);
        }
        pushed++;
        setProgress(Math.round((pushed / files.length) * 100));
      }

      setStatus(`Pushed ${pushed} files to ${repo}`, "done");
    }

    // Show repo link
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

// ── Init ─────────────────────────────────────────────────
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
  document.getElementById("btnSchemas").addEventListener("click", previewSchemas);
});
