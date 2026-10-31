# CHECKPOINT — tg-personal (v0.9.0)

Personal Telegram client: TypeScript + Vite + teleproto (MTProto over WebSocket),
wrapped as an iOS app with Capacitor 8 (SPM). Repo: `mfarouc-cloud/tg-personal`.

## Done in v0.9.0
| Area | Change | Files |
|---|---|---|
| Secrets → Keychain | API id/hash, all MTProto sessions, account list, active slot and passcode hash now live in the **iOS Keychain** (`@aparajita/capacitor-secure-storage`, access `afterFirstUnlockThisDeviceOnly`, no iCloud sync). Loaded into memory at boot; old localStorage copies are migrated once and deleted. Browser dev build falls back to localStorage. | `src/telegram/secureStore.ts` (new), `src/telegram/config.ts`, `src/features/passcode.ts`, `src/main.ts`, `src/ui/settings.ts`, `src/ui/login.ts` |
| Upload resume | Upload parts that fail because of network loss/background are **not** failed: the upload pauses (`tg.uploadStalled`), waits until the app is foreground + reconnected, then re-sends the same part with the same `fileId`. FLOOD_WAIT honored. UI shows "⏸ الرفع متوقف…". | `src/telegram/client.ts` (`waitResumable`, `uploadLarge`), `src/ui/chat/view.ts` |
| iOS background grace | `beginBackgroundTask` when the scene goes to background (system-limited, ~30 s typical) so short transfers finish. | `ios/App/App/SceneDelegate.swift` |
| CI | macOS runner builds unsigned IPA; new verify step checks plugin linked + Keychain code bundled. | `.github/workflows/ios.yml` |
| Linux orchestration | One command from Oracle Linux to build + download the IPA. | `scripts/build-ipa.sh` |

## Transfer behaviour (honest)
- App in foreground: upload/download runs normally.
- App sent to background: continues only for the short grace time iOS gives (not guaranteed, usually ~30 s). After that iOS suspends the WebView, the socket drops, the upload **pauses** (doesn't fail).
- App reopened (same process still alive): upload **resumes** from the next missing part.
- App killed by iOS/user: the in-memory upload is lost; must resend. (True background uploads would need a native `URLSession` background transfer, which MTProto over WebSocket can't use.)

## Tests run here (virtual env, not a phone)
- `tsc --noEmit` clean, `vite build` OK.
- Headless Chromium harness: `dev/harness.html?s=upload` — socket drops on part 2 three times → `uploadStalled=true`, no error; after reconnect all 5 parts sent with one fileId.
- Regression smoke: chat2, list2, insight, premium — 0 errors.
- Keychain path: **not runnable here** (needs iOS). CI only verifies the plugin is linked.

## Must be tested on the iPhone
1. Fresh login → kill app → reopen: still logged in (session from Keychain).
2. Upgrade from 0.8.0 data (if LiveContainer kept it): still logged in, then Settings → no data loss.
3. Send a 50–100 MB video, switch app for 10 s → back: continues. Switch for 2+ min → back: shows ⏸ then resumes.
4. Voice note, save media (share sheet), multi-account switch.

## Resume commands
```bash
# Linux (WSL or Oracle Linux)
git clone https://github.com/mfarouc-cloud/tg-personal && cd tg-personal
npm ci
npm run dev                       # browser dev build (http://localhost:5173)
npx tsc --noEmit && npm run build # type-check + production web build
npx cap sync ios                  # copy web build + plugins into ios/
git push origin main              # triggers IPA build on GitHub macOS runner
./scripts/build-ipa.sh            # or: trigger + wait + download IPA into ./ipa-out
./scripts/build-ipa.sh com.example.app.TEAMID   # reuse an existing App ID
```

## Next candidates
- Retry `sendMedia` once with re-upload if Telegram returns `FILE_PART_*_MISSING` after a very long pause.
- Native local notifications via `@capacitor/local-notifications` (no APNs on free signing).
