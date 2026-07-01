# Chrome Web Store submission prep (Task 10)

Non-Chrome, non-account-dependent groundwork for the plan's Task 10. Packaging,
screenshots, and the actual dashboard submission still require a live Chrome
session against a real GHL account — not done here.

## Status

- **Version bumped**: `manifest.json` → `3.1.0` (was `3.0.0`), reflecting everything
  shipped in Tasks 1–6 (asset-collector fix, AI Studio multi-page crawl, hardened
  shell detection, legacy funnel/website/blog capture, live preview, Git Data API
  push) plus the 2026-07-01 branding sweep. If Task 9 (Stripe license server) lands
  later, bump again before submitting — don't submit 3.1.0 as final if more ships
  first.
- **Privacy policy (`privacy.html`) already updated** as part of the branding sweep
  (commit `133f7e6`) — covers current behavior accurately. Still needs a matching
  pass on the *separate* CWS Developer Dashboard "Privacy practices" form once
  submission actually happens (that's a dashboard form, not a file — can't be
  prepped here).
- **Not done here**: zipping the extension for upload, taking fresh screenshots
  (needs a live Chrome window), and the actual dashboard submission. Do these
  only once ready to submit, since screenshots should reflect the final shipped
  state, not a snapshot from mid-session.

## Permission justifications (draft — match against manifest.json before submitting)

Current `manifest.json` permissions as of `3.1.0`:
`activeTab, scripting, downloads, storage, webNavigation, alarms, tabs, unlimitedStorage`
plus `host_permissions: ["<all_urls>"]`.

- **`host_permissions: <all_urls>`** — "The extension captures and exports websites
  built on arbitrary third-party platforms (GoHighLevel, Framer, Webflow, Lovable,
  Bolt, v0, Cursor) and fetches page assets (images, fonts, CSS) hosted on arbitrary
  CDN domains the user's site references. The site being captured, and its asset
  hosts, are not known in advance and cannot be scoped to a fixed domain list."

- **`tabs`** — "Used to open a captured page in a new tab for live preview, and (for
  legacy GHL funnel/website/blog capture) to open each discovered page in a
  background tab one at a time to capture it, then close it. Not used to read tab
  content the user hasn't explicitly asked to capture."

- **`webNavigation`** — "Used to enumerate frames on the active tab so the extension
  can find the correct iframe to capture — both GHL AI Studio previews and legacy
  GHL builder previews render inside iframes on a different origin/context than the
  top-level builder page."

- **`scripting`** — "Used to inject the extension's own capture script into the
  active tab and its frames, only when the user clicks the extension's capture
  button — never automatically or on pages the user hasn't interacted with."

- **`alarms`** — "Used for the optional auto-backup scheduler: if the user enables
  periodic snapshots, an alarm fires on their chosen interval to re-run a capture of
  the currently open GHL tab. No alarm is created unless the user explicitly turns
  this on."

- **`storage`** — "Used to store the user's own settings (auto-backup interval,
  last-used GitHub repo, etc.), locally-cached project snapshots, and — temporarily,
  for the live preview feature — the most recently captured project's data so the
  preview tab can read it. Nothing here is transmitted anywhere; it's local browser
  storage only."

- **`downloads`** — "Used to save the exported ZIP file to the user's Downloads
  folder when they choose the ZIP export option."

- **`unlimitedStorage`** — "Multi-page captures (a full AI Studio project or legacy
  funnel/website/blog with many pages) can exceed `chrome.storage.local`'s default
  ~10MB quota when temporarily staging data for the live preview feature. This
  permission removes that cap; it does not grant access to anything beyond the
  extension's own local storage."

## Not yet applicable

Task 9 (Stripe-backed license validation) hasn't been built — there is currently
no network call to a license server, so no justification is needed for that yet.
Add one when Task 9 ships (a call to `license.freemyghl.com`, sending only the
license key, no browsing/page data).
