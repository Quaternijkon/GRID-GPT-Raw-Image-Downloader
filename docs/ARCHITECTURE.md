# Architecture

GRID GPT Raw Image Downloader is a client-only Chrome Manifest V3 extension. `manifest.json` loads dependency-free content scripts on `chatgpt.com`; `background.js` receives validated download requests and calls `chrome.downloads` so files can be placed in subfolders.

The export flow in `content.js` collects API image pages, validates the complete set, assigns stable oldest-first global numbers, optionally reconstructs prompt groups, and then submits original image bytes to Chrome. It writes metadata and a result report with explicit partial failures. A queued download means Chrome accepted the request; it does not prove the file finished writing to disk.

| Module | Responsibility |
| --- | --- |
| `image-lists.js` | Paginated gallery and Library collection with partial-result diagnostics. |
| `image-numbering.js` | Full-set file-ID deduplication, creation-time ordering and incremental number filtering. |
| `original-images.js` | Same-origin authentication, original-resource resolution, byte validation and quality measurements. |
| `prompt-conversations.js` | Bounded conversation reads, fixed ten-second serial pacing and an additional ten-second shared wait after HTTP 429. |
| `prompt-resolver.js` | Structural prompt recovery from real output ancestry, including reference-image and text-only requests. |
| `prompt-groups.js` | Exact cumulative-text grouping and the fixed `未解析/` fallback. |
| `download-queue.js` | Image-stage Auto/manual admission; independent from prompt-reading concurrency. |
| `download-progress.js` | Progress dashboard and transfer-rate estimates. |
| `background.js` | Validated local download paths, prompt TXT overwrite policy and Chrome download acknowledgements. |

The extension sends no data to a third-party service. It uses the user's authenticated ChatGPT session only for ChatGPT endpoints. Session tokens stay in memory and are not written to reports. Raw conversation bodies are not exported; prompt text and limited provenance are included only when prompt export is selected.

Image-list identity and an original download URL do not prove that the corresponding output message still exists in the conversation mapping. Missing output identity, unsupported structure and unavailable originals remain explicit failures rather than inferred prompts or thumbnail substitutions. HTTP 429 pauses prompt reads and retries the same conversation; other bounded network errors and structural errors are reported separately. In-memory prompt progress is lost when the page closes or reloads.

Original-image resolution first cycles through fresh descriptor endpoints and explicit original candidates for up to three rounds. If those rounds end only because of transient network, timeout, HTTP 408/429 or 5xx failures, `content.js` keeps the task nonterminal and places it into a serialized recovery lane for up to twelve additional rounds. The recovery lane applies shared congestion backoff and prevents multiple already-admitted tasks from retrying simultaneously. Permanent missing/invalid originals still fail promptly; successful images are never downloaded again.

Regression definitions are in `tests/` and use Node's built-in test runner. The current release has received static review; the session's standing instruction has deferred automated test execution and a full authenticated end-to-end run.

The prompt collector uses one full-conversation request at a time. It waits ten seconds after each completed request and another ten seconds after HTTP 429; a longer service Retry-After wins. It keeps the same conversation pending through 429 rather than marking later conversations failed. The image gallery list and sampled original PNG metadata do not carry the exact cumulative user prompt, and opening the native media viewer produced no alternate prompt-detail request in the observed account.

## Prompt-only retry

`prompt-retry.js` accepts a prior schema-4 result exported with prompts enabled or a prior prompt-retry result. It checks the current ChatGPT route, output folder, image sequence, file/conversation identity, previous recovery path and Chrome download ID before any authenticated read. Prompt groups use a content-addressed identity derived from exact normalized text, so a recovered prompt has the same destination as an initial success. Unresolved originals are staged in sibling `<folder>-recovery/未解析`; recovery writes the shared `prompt.txt`, retrieves the original again, waits for the final grouped download to complete and asks `background.js` to remove the staged file. A failed placement or cleanup remains in the checkpoint rather than being reported as recovered.

After a prompt-enabled run, `content.js` reduces unresolved records to a route-scoped checkpoint containing only image/conversation identities, numbering, the expected `未解析/` path and safe error diagnostics. `background.js` validates and stores at most ten checkpoints in extension-local storage. The settings dialog offers the matching page's checkpoint as a one-click retry; users may still import an exported result if local extension state was cleared. Errors consistent with temporarily incomplete conversation data receive one automatic paced reread in the same run before they enter the checkpoint.

Terminal original failures use a separate route-and-folder checkpoint containing the exact sequence, file identity, original name and final group destination. Retrying this checkpoint bypasses image discovery and conversation reads. Successful retries overwrite the exact intended path; unresolved successes also update the prompt checkpoint with their new download ID. Legacy schema-4 result imports retain numeric group destinations, while new exports use content-addressed groups.
