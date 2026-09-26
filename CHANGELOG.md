# Changelog

## 1.9.14 — 2026-09-26

- The second targeted pass recovered and wrote 60 numbered prompt sidecars. Of 40 remaining images, 30 were still blocked by historical field-type variations inside the exact `tether_browsing_display` tool envelope.
- Recognize that non-prompt tool envelope by exact content type and a closed top-level key set, without assuming its historical fields are always strings or arrays. It still cannot become user prompt text or an image output.
- The second pass made 43 conversation requests with no HTTP 429 and no original-image download. The third pass imports only the second report's 40 remaining failures.

## 1.9.13 — 2026-09-26

- Used the first live prompt-only retry diagnostics to classify `tether_browsing_display` and `system_error` tool content as non-prompt events with exact schema checks.
- Replays every exact duplicate output candidate independently. A duplicate resource is accepted only when every verified ancestry produces the same cumulative prompt; differing or partially unsupported ancestries remain explicitly ambiguous.
- The diagnostic run read exactly 43 failed conversations with 43 requests, no HTTP 429 and no original-image downloads. Its retry report is the input for the next remaining-failures-only pass.

## 1.9.12 — 2026-09-26

- Removed the native file input's JSON MIME filter after macOS displayed valid result files but disabled the Open action. Imported content still passes the extension's strict schema, route, folder and per-image identity validation before any authenticated request.

## 1.9.11 — 2026-09-26

- Added a prompt-only retry path that imports the extension's prior schema-4 result, checks page, folder, image identity and unresolved paths, then reads only the failed images' distinct conversations. The original-image discovery and download pipeline is not entered.
- Recovered prompts are written as numbered text sidecars next to the existing images in `未解析/`; a separate retry JSON keeps each image/conversation identity, previous and current errors, save result and request count. Subsequent runs may import that report to retry only its remaining failures. The image queue is never used by this path.
- Added structured diagnostics for unsupported conversation content and missing base text. The observed 1.9.10 result has 100 unresolved images in 43 conversations: 90 `unsupported_content`, 8 `target_not_found`, 2 `missing_base`; all 100 queued image paths exist on disk. The old report does not contain enough schema detail to safely broaden the resolver yet.
- Static syntax checks and validation against the actual prior report were done. Automated tests and live authenticated retry were not run under the standing verification instruction and current browser-control limitation.

## 1.9.10 — 2026-09-25

- Prompt conversation reads remain serial, with a fixed ten-second completion-to-next-start gap.
- On HTTP 429, add ten more seconds of shared cooldown, so the earliest retry is about twenty seconds after the limited response. A longer server Retry-After still takes precedence. Remove the extension's exponential per-request gap and fallback cooldown; retain retrying the same conversation without mass-deferring later work.
- This user-selected schedule does not guarantee a rate-limit-free run. With 413 conversations, fixed spacing alone is at least about 69 minutes before network latency or server wait time. Image-stage Auto/manual concurrency is unchanged.
- Updated static regression definitions and docs; no automated tests or full live export under the standing user instruction.

## 1.9.9 — 2026-09-24

- Cap the post-429 per-conversation gap at 10 seconds instead of five minutes. Keep the initial one-second serial pace. If the service sends Retry-After, honor it; otherwise use a separate 1/2/4/5-minute shared cooldown and continue retrying the same conversation.
- Record whether the most recent cooldown came from a server Retry-After or the extension fallback, plus both durations. Progress labels the source so long wait estimates are not misrepresented as server instructions.
- Research of the current logged-in Images UI found no separate prompt-detail request when opening a media card; its viewer shows title/image/edit controls. In 1,531 gallery records prompt/recreation_prompt were null and messages empty. Sample original PNGs had no text prompt chunks or ASCII prompt marker in C2PA blocks. Exact prompt recovery still depends on conversation data, so no client-side schedule can guarantee zero HTTP 429 against an unpublished service quota.
- Regression definitions and static review updated. No automated tests or full live export under the standing user instruction. The already-running 1.9.8 tab retains its old in-memory scheduler until the page is reloaded.

## 1.9.8 — 2026-09-24

- Established the independent GRID GPT Raw Image Downloader codebase and identity.
- Original-image export preserves source bytes, validates image containers and reports dimensions, hashes, retries and download submission results.
- Gallery/Library pagination, full-set chronological numbering and an exclusive incremental boundary support large collections.
- Optional prompt restoration follows actual conversation parent chains. Non-image attachments are classified with visible user text; unresolved prompts use a separate folder with explicit reasons. Prompt reading begins serially with a one-second gap, then honors Retry-After and slows after HTTP 429.
- Image downloads use bounded Auto/manual concurrency independently of prompt reads. Progress shows transfer estimates and separate prompt/image failures.
- Static review and regression definitions are present. Automated tests and a complete live run were deferred under the user's earlier verification instruction; server quotas and conversation response completeness remain external limits.
