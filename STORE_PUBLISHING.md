# Publishing to Chrome Web Store and Edge Add-ons

This document explains how to publish Zoom Codex Interpreter so installed users receive true automatic updates.

## Important distinction

There are two kinds of updates:

1. **Unpacked extension from a ZIP**
   - The extension can check GitHub Releases and show a `NEW` badge.
   - It cannot silently replace its own files.
   - The user must download the new ZIP and click **Reload** in `chrome://extensions` or `edge://extensions`.

2. **Extension installed from a browser store**
   - Chrome Web Store and Microsoft Edge Add-ons automatically update the extension.
   - Users do not need to reinstall or reload manually.

For true automatic updates, publish to both stores.

## Build the store packages

```bash
./scripts/release.sh
```

Upload:

- Chrome Web Store: `dist/ZoomCodexInterpreter-chrome-vX.Y.Z.zip`
- Edge Add-ons: `dist/ZoomCodexInterpreter-edge-vX.Y.Z.zip`

Both ZIP files have `manifest.json` at the archive root.

## Chrome Web Store

1. Open the Chrome Web Store Developer Dashboard.
2. Register a developer account. Google currently charges a one-time registration fee.
3. Click **New item**.
4. Upload `ZoomCodexInterpreter-chrome-vX.Y.Z.zip`.
5. Fill in the store listing:
   - Name: `Zoom Codex Interpreter`
   - Category: Productivity
   - Language: Chinese / English
   - Short description: translate Zoom web live captions with local or AI translation
   - Detailed description: describe local mode, AI mode, and the local `server.py` requirement for AI mode
6. Upload screenshots:
   - 1280x800 or 640x400
   - Include the extension popup and the compact subtitle overlay
7. Complete the privacy practices form:
   - Local mode: caption text is translated in the browser.
   - AI mode: caption text is sent to the user's own local server at `127.0.0.1:8765`, then to the user's configured model provider.
   - No analytics are collected by the extension.
8. Submit for review.
9. After approval, publish the item.

### Publishing updates to Chrome Web Store

1. Increase `extension/manifest.json` version.
2. Update `CHANGELOG.md`.
3. Commit and tag:
   ```bash
   git add .
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```
4. Download the generated ZIP from GitHub Releases.
5. Open the Chrome Web Store Developer Dashboard.
6. Upload the new ZIP under **Package**.
7. Submit the update.

## Microsoft Edge Add-ons

1. Open Microsoft Partner Center.
2. Enroll in the Microsoft Edge program.
3. Create a new extension.
4. Upload `ZoomCodexInterpreter-edge-vX.Y.Z.zip`.
5. Fill in:
   - Name: `Zoom Codex Interpreter for Edge`
   - Category: Productivity
   - Language: Chinese / English
   - Description
   - Privacy policy and data usage
   - Screenshots
6. Submit for certification.
7. After approval, publish the extension.

### Publishing updates to Edge Add-ons

1. Build a new Edge ZIP with `./scripts/release.sh`.
2. Open the existing extension in Partner Center.
3. Upload the new package.
4. Submit the update.

## Version and release checklist

- [ ] `extension/manifest.json` version updated
- [ ] `VERSION` updated
- [ ] `updates/update.json` updated
- [ ] `CHANGELOG.md` updated
- [ ] `./scripts/release.sh` passes
- [ ] Git commit and tag created
- [ ] Tag pushed to GitHub
- [ ] GitHub Actions Release succeeded
- [ ] Chrome Web Store package uploaded
- [ ] Edge Add-ons package uploaded

## GitHub Actions

`.github/workflows/release.yml` runs when a `v*` tag is pushed.

It builds:

- Chrome ZIP
- Edge ZIP
- compatibility ZIP
- full project ZIP
- Git bundle
- checksums
- `update.json`

All files are uploaded to the GitHub Release for that tag.
