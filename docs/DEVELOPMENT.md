# Development

GRID has no runtime dependencies or build step. Chrome loads the root scripts in the order declared by `manifest.json`.

Run the complete local verification before a release:

```sh
npm run check
```

This checks the syntax of the runtime, test and maintenance scripts, then runs every regression test with Node's built-in test runner.

Authenticated browser verification remains separate because ChatGPT, Grok and Gemini use account-specific internal APIs. For a live release check:

1. Load the repository as an unpacked extension in Chrome.
2. Export one small image-only batch from each supported provider.
3. Export a prompt-enabled batch containing at least two prompt groups.
4. Interrupt one media download and confirm the next run reports and recovers it.
5. Confirm the result report distinguishes Chrome acceptance from completed files.
6. Compare a saved file's byte count and SHA-256 with its result record.

Do not commit authenticated response bodies, session values or exported user media as fixtures. Tests should use minimal synthetic API shapes and byte signatures.
