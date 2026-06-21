# 🔓 Keep My GHL — Site Exporter

Export, backup, audit & deploy any GoHighLevel AI Studio site — or any Framer, Webflow, Lovable, Base44, or AI-built page. One click. Own your work forever.

## Supported Platforms

| Platform | Grab | Deploy | SEO Audit | Brand Kit | Source Code |
|----------|------|--------|-----------|-----------|-------------|
| GoHighLevel AI Studio | ✅ Full | ✅ | ✅ | ✅ | ✅ |
| GoHighLevel Vibe Builder | ✅ Full | ✅ | ✅ | ✅ | ✅ |
| Framer | ✅ | ✅ | ✅ | ✅ | — |
| Webflow | ✅ | ✅ | ✅ | ✅ | — |
| Lovable / Base44 / Bolt / v0 | ✅ | ✅ | ✅ | ✅ | — |
| Any website in Chrome | ✅ | ✅ | ✅ | ✅ | — |

## Deploy Targets

| Target | How |
|--------|-----|
| **💾 ZIP** | Download self-contained folder, open in any editor |
| **🐙 GitHub** | Push to any repo via GitHub API — no git CLI needed |
| **📄 GitHub Pages** | Push + enable Pages — live URL in seconds |
| **🔺 Netlify** | Deploy via Netlify API with live URL |
| **▲ Vercel** | Deploy via Vercel API with live URL |
| **☁️ Cloudflare Pages** | Direct Upload v2 API — fastest global CDN |

## Tools

| Tool | What it does |
|------|-------------|
| **🔍 SEO Audit** | 10 checks — title, meta description, OG tags, JSON-LD, alt text, HTTPS |
| **🎨 Brand Kit** | Extracts all colors + fonts → downloadable `brand-kit.json` |
| **🛡️ GDPR Check** | Privacy link, cookie consent, phone exposure, noindex, canonical |
| **🧹 Scrub Trackers** | Removes GTM, GA4, Facebook Pixel, HotJar, TikTok, Intercom, Clarity |
| **🕸️ Crawl Funnel** | Finds all same-domain pages, fetches each, packages into one ZIP + sitemap |

## Version History

Auto-backup runs on a schedule (1h / 6h / Daily / Weekly). Up to 25 snapshots stored locally. Restore any snapshot to re-deploy from it.

## Installation

1. Open Chrome → go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **"Load unpacked"**
4. Select the extension folder
5. The extension icon appears in your toolbar

## Usage

1. Open any GoHighLevel page (or Framer, Webflow, Lovable, etc.) in Chrome
2. Click the **Keep My GHL** icon in your toolbar
3. Click **"📥 Grab Full Project"**
4. Use any deploy button, or open the Tools panel for audit/brand/compliance features

## File Structure After Export

```
project/
├── index.html          ← Full rendered page
├── meta.json           ← All meta/OG/Twitter tags
├── manifest.json       ← Export metadata
├── README.md           ← Auto-generated summary
├── schemas/
│   ├── schema-1-localbusiness.json
│   └── ALL-SCHEMAS-PASTE.txt
├── css/
│   ├── style-0.css
│   └── inline-1.css
├── js/
│   └── script-0.js
└── images/
    └── image-urls.json
```

## Troubleshooting

- **"No response from content script"** → Refresh the page and try again
- **CORS errors on CSS/JS** → Cross-origin stylesheets saved as URLs only
- **Empty schemas** → The page has no JSON-LD markup
- **Icons missing** → Open `generate-icons.html` in Chrome to generate them

## By IgnitivIO

Built primarily for GoHighLevel AI Studio — works on any AI-built or hosted website.
