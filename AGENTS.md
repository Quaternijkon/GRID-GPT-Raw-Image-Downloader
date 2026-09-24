# GRID repository context

- This is a dependency-free Chrome Manifest V3 extension. Runtime scripts live at the repository root and are loaded in the order declared by `manifest.json`.
- `content.js` owns the page UI and export flow. `background.js` is the only caller of `chrome.downloads`. Keep all processing client-side and limit authenticated requests to the existing ChatGPT origin.
- `image-lists.js` discovers complete pages; `image-numbering.js` assigns stable global numbers; `original-images.js` retrieves and validates original bytes. `prompt-conversations.js`, `prompt-resolver.js`, and `prompt-groups.js` handle optional prompt export. `download-queue.js` and `download-progress.js` manage image-stage admission and display.
- The JSON result says a download is queued when Chrome accepts it; queued is not disk completion. Preserve exact image bytes, explicit partial errors, and filename/path validation.
- Regression definitions are in `tests/` and use Node's built-in test runner. Follow the user's session-level verification instructions before executing them.
- Keep README focused on project status and release notes. Put implementation details in `docs/ARCHITECTURE.md`.
