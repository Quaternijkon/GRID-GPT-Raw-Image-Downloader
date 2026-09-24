# Architecture

GRID GPT Raw Image Downloader is a client-only Chrome Manifest V3 extension. `manifest.json` loads dependency-free content scripts on `chatgpt.com`; `background.js` receives validated download requests and calls `chrome.downloads` so files can be placed in subfolders.

The export flow in `content.js` collects API image pages, validates the complete set, assigns stable oldest-first global numbers, optionally reconstructs prompt groups, and then submits original image bytes to Chrome. It writes metadata and a result report with explicit partial failures. A queued download means Chrome accepted the request; it does not prove the file finished writing to disk.

| Module | Responsibility |
| --- | --- |
| `image-lists.js` | Paginated gallery and Library collection with partial-result diagnostics. |
| `image-numbering.js` | Full-set file-ID deduplication, creation-time ordering and incremental number filtering. |
| `original-images.js` | Same-origin authentication, original-resource resolution, byte validation and quality measurements. |
| `prompt-conversations.js` | Bounded conversation reads, one-second initial serial pacing and shared HTTP 429 cooldown. |
| `prompt-resolver.js` | Structural prompt recovery from real output ancestry, including reference-image and text-only requests. |
| `prompt-groups.js` | Exact cumulative-text grouping and the fixed `未解析/` fallback. |
| `download-queue.js` | Image-stage Auto/manual admission; independent from prompt-reading concurrency. |
| `download-progress.js` | Progress dashboard and transfer-rate estimates. |
| `background.js` | Validated local download paths, prompt TXT overwrite policy and Chrome download acknowledgements. |

The extension sends no data to a third-party service. It uses the user's authenticated ChatGPT session only for ChatGPT endpoints. Session tokens stay in memory and are not written to reports. Raw conversation bodies are not exported; prompt text and limited provenance are included only when prompt export is selected.

Image-list identity and an original download URL do not prove that the corresponding output message still exists in the conversation mapping. Missing output identity, unsupported structure and unavailable originals remain explicit failures rather than inferred prompts or thumbnail substitutions. HTTP 429 pauses prompt reads and retries the same conversation; other bounded network errors and structural errors are reported separately. In-memory prompt progress is lost when the page closes or reloads.

Regression definitions are in `tests/` and use Node's built-in test runner. The current release has received static review; the session's standing instruction has deferred automated test execution and a full authenticated end-to-end run.
