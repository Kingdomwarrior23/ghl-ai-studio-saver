# 📦 GHL Project Saver — Chrome Extension

Save complete GoHighLevel AI Studio projects from the browser. One-click export of HTML, CSS, JS, images, fonts, schemas, and all assets.

## Installation

1. Open Chrome → go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **"Load unpacked"**
4. Select the `ghl-saver` folder from your Desktop
5. The extension icon appears in your toolbar

## Usage

1. Open any GoHighLevel page in Chrome (AI Studio preview, live site, vibepreview.com, etc.)
2. Click the **GHL Project Saver** icon in your toolbar
3. Click **"📥 Grab Full Project"**
4. Wait for extraction to complete
5. Click **"💾 Download ZIP"** to save everything locally

## What It Captures

| Asset | Details |
|-------|---------|
| **HTML** | Full rendered DOM (includes dynamically injected content like JSON-LD) |
| **Schemas** | All JSON-LD structured data — saved individually + paste-ready format |
| **Meta Tags** | All meta, OG, Twitter Card, canonical, viewport |
| **CSS** | All stylesheets (external + inline), with CSS rules extracted |
| **JavaScript** | All script tags (external URLs + inline code) |
| **Images** | All `<img>` tags, background images, and inline SVGs |
| **Fonts** | Google Fonts links and @font-face declarations |
| **Links** | All anchor tags with href, text, and target |

## GitHub Push

1. Click **"🐙 Push to GitHub"**
2. Enter your GitHub Personal Access Token (needs `repo` scope)
3. Enter repo name (e.g. `yourusername/project-name`)
4. Files are pushed directly — no git CLI needed

## File Structure After Export

```
ghl-project/
├── index.html          ← Full rendered page
├── meta.json           ← All meta/OG/Twitter tags
├── manifest.json       ← Export metadata
├── README.md           ← Auto-generated summary
├── schemas/
│   ├── schema-1-localbusiness.json
│   ├── schema-2-faqpage.json
│   └── ALL-SCHEMAS-PASTE.txt  ← Copy-paste into GHL
├── css/
│   ├── style-0.css
│   └── inline-1.css
├── js/
│   ├── script-0.js
│   └── inline-1.js
└── images/
    └── image-urls.json  ← All image URLs + alt text
```

## Troubleshooting

- **"No response from content script"** → Refresh the page and try again
- **CORS errors on CSS/JS** → Cross-origin stylesheets are saved as URLs only
- **Empty schemas** → The page really has no JSON-LD (AI Studio lied!)
- **Icons missing** → Open `generate-icons.html` in Chrome to generate them

## By IgnitivIO
Built for extracting and auditing GoHighLevel sites.
