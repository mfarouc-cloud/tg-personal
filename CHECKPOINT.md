# CHECKPOINT — HBOLT (v1.1.0, formerly tg-personal)

Personal Telegram client: TypeScript + Vite + teleproto (MTProto over WebSocket),
wrapped as an iOS app with Capacitor 8 (SPM). Repo: `mfarouc-cloud/tg-personal`.

## Done in v1.1.0
| Area | Change | Files |
|---|---|---|
| Render fixes | Photos/videos sized from their real pixel dimensions (aspect-ratio, `object-fit: contain`, no min-width/crop); avatars always circular with clipped blur | `src/features/media.ts` (`mediaDims`), `src/ui/mediaView.ts` (`sizeFrame`), `src/style.css` |
| Nicegram-style look | Translucent blurred bars/tabs/composer, rounded sheets & pill tabs | `src/style.css` |
| Gallery viewer | Tap in Media tab → fullscreen swipe viewer (swipe/arrows, zoom, save, forward, open in chat), neighbours preloaded; no jump to chat | `src/features/galleryViewer.ts`, `src/ui/chatInfo.ts` |
| Gallery selection | "☑ تحديد" in Media/Files/Links/Voice tabs; bottom bar: اختيار الكل / ⬇ تنزيل / ↪ توجيه | `src/ui/chatInfo.ts` |
| Select all (no limit) | `tg.sharedMediaAll` pages 100 at a time until the end (FLOOD_WAIT-aware, cap 20 000) and selects every media id | `src/telegram/client.ts` |
| Infinite scroll | Gallery loads 100 more on scroll (was a fixed 60) | `src/ui/chatInfo.ts` |
| Bulk save | iOS: one share sheet per 20 files ("Save N items"); browser: sequential downloads | `src/features/media.ts` (`saveMany`) |

## Done in v1.0.0 (HBOLT)
| Area | Change | Files |
|---|---|---|
| Rebrand | Display name / titles / PWA manifest → HBOLT | `capacitor.config.ts`, `ios/App/App/Info.plist`, `index.html`, `vite.config.ts`, `src/ui/chatlist.ts`, `src/ui/settings.ts` |
| Bulk select + safe forward | ⋮ → "تحديد رسايل" or long-press → "☑ تحديد"; "🖼 الميديا" / "اختيار الكل"; forward queue: batches of 10 ids, 2 s apart, FLOOD_WAIT/SLOWMODE honoured, cancellable | `src/features/bulkForward.ts`, `src/ui/forward.ts`, `src/ui/chat/view.ts`, `client.forwardMany` |
| Header quick actions | ⋮ in chat header: select, mute/unmute, search, info, join, leave | `src/ui/chat/view.ts` |
| Media | Pinch / double-tap zoom + pan viewer; video thumbnails with duration badge | `src/features/zoom.ts`, `src/ui/mediaView.ts` |
| Member details | Local on-device "seen in" index adds chats not returned by getCommonChats | `src/features/seenIndex.ts`, `src/ui/userInsight.ts` |
| Smart links | Cache of resolved links; expired invite → previously resolved chat; `t.me/c/<id>/<post>` | `src/features/linkResolver.ts`, `src/main.ts`, `src/ui/chat/format.ts` |
| Power tools | "🔵 غير المقروء" filter, "✓ تعليم كمقروء" (throttled, respects ghost mode) | `src/features/powerTools.ts`, `src/ui/chatlist.ts` |
| UI | Screen transitions, blurred top bars, rounded bubbles, selection styling (reduced-motion aware) | `src/style.css` |
| Signing in CI | Workflow signs with your cert when repo secrets `SIGN_P12_BASE64`, `SIGN_P12_PASSWORD`, `SIGN_PROFILE_BASE64` exist; minimal entitlements | `.github/workflows/ios.yml` |

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
