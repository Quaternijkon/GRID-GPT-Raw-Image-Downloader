# Changelog

## 1.9.8 — 2026-09-24

- Established the independent GRID GPT Raw Image Downloader codebase and identity.
- Original-image export preserves source bytes, validates image containers and reports dimensions, hashes, retries and download submission results.
- Gallery/Library pagination, full-set chronological numbering and an exclusive incremental boundary support large collections.
- Optional prompt restoration follows actual conversation parent chains. Non-image attachments are classified with visible user text; unresolved prompts use a separate folder with explicit reasons. Prompt reading begins serially with a one-second gap, then honors Retry-After and slows after HTTP 429.
- Image downloads use bounded Auto/manual concurrency independently of prompt reads. Progress shows transfer estimates and separate prompt/image failures.
- Static review and regression definitions are present. Automated tests and a complete live run were deferred under the user's earlier verification instruction; server quotas and conversation response completeness remain external limits.
