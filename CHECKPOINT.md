# CHECKPOINT — HBOLT (v1.2.0, formerly tg-personal)

Personal Telegram client: TypeScript + Vite + teleproto (MTProto over WebSocket),
wrapped as an iOS app with Capacitor 8 (SPM). Repo: `mfarouc-cloud/tg-personal`.

## Native patch 0060 — auto-wait for connection + manual Resume
A connection drop mid-run used to stall Clean Save (it never uploaded the rest). Now the run **waits for the connection to come back** before each chunk and before each retry (`account.network.connectionStatus` online gate), so it pauses on disconnect and continues automatically — nothing lost. Added a manual **🔄 Resume Clean Save** menu item (next to Clean Save All) that continues the saved durable queue from where it stopped (cancelling a stalled run first), for when the user wants to kick it by hand. `HBOLTBulkForward.swift` (`hboltWaitForOnline`, `resumeNow`), `PeerInfoScreenMessageActions.swift`, `PeerInfoScreenDisplayMediaGalleryContextMenu.swift`.

## Native patch 0059 — reliable fast albums (fresh refs) + fresh start + correct order
Root cause of the huge reject counts (2314/2766 on an OPEN channel): the queued messages had STALE file references and many weren't in the local DB any more — so the by-reference (no-download) album send failed (FILE_REFERENCE_EXPIRED) and evicted messages were counted "missing/rejected" without even being tried. Fix: each chunk is **re-fetched fresh from the cloud** (`_internal_getMessagesLoadIfNecessary`, skipLocal) so file references are valid — the by-reference album send becomes reliable (fast, no download) for open channels, and nothing is falsely rejected. Also: a manual Clean Save now **always starts fresh** (cancels any run in progress, clears the old durable queue) so it re-drains oldest→newest instead of continuing a stale queue; launch-resume still covers a kick/kill mid-run. `HBOLTBulkForward.swift`.

## Native patch 0058 — fast server-side albums of 10 + zero loss (unified engine)
User priority: media always regrouped into **albums of 10** (descending remainder 8,7,…,2), **super-sonic** server-side when the source is open (no download), **nothing ever dropped**, and a kick / leave / restriction must not break it. Unified engine: an item is first sent **by reference** (`inputMediaPhoto`/`inputMediaDocument` by id via `sendMultiMedia` with a shared grouping key) — a server-side copy, no download, instant for 4K video, that **regroups even individually-posted media into fresh albums of 10**, clean (no "forwarded from"). An atomic album failure (one stale/bad item) is handled by album-recover: **retry the whole album** (file references revalidate on retry), then binary-split to isolate the one bad item, which falls back to **download + re-upload** (the only option for restricted sources). Per-chunk retries (×5) + Clean Save's durable queue + launch-resume guarantee nothing is lost to a kick/restart. This one engine now backs Clean Save AND every bulk forward (Sonic / Selected / Forward All) to any chat. `HBOLTBulkForward.swift` (`hboltCleanSaveAlbumRecover`, `hboltCleanSaveReferencePass`, `hboltSendReliableToPeer`). Supersedes the earlier 0058 (native forward, which kept source grouping) and 0059.

## Native patch 0057 — no "too many attempts" when opening many invite links
Opening many invite links quickly used to hit FLOOD_WAIT ("too many attempts") and interrupt work. Now invite checks (`checkChatInvite`) and joins (`importChatInvite`) auto-wait short floods via MTProto; a reported FLOOD_WAIT is waited out and retried (up to 3×, ≤90s) so the preview opens on its own just later; and successful checks are cached for 3 min so re-opening the same link doesn't re-hit the server. The server-side limit is not bypassed — requests are paced and waited for, never forced (forcing it risks the account). `JoinLink.swift`.

## Native patch 0056 — "Media preview" from a link long-press
Long-pressing a Telegram chat/invite link now offers **🖼 Media preview** (both the action-sheet and context-menu variants). It resolves the link to a peer by every available means — public username, an invite you can peek or are already in, or a peer recovered from an expired / request-to-join link via the 0055 invite-title cache — and opens that peer's read-only profile (Media tab) WITHOUT joining. When the link is a private group you have no access to, it says so plainly (Telegram serves a non-member no media). Only shown for t.me / telegram.me chat links. `HBOLTMediaPreview.swift` (new), `ChatControllerOpenLinkContextMenu.swift`.

## Native patch 0055 — Expired link recovery for request-to-join links
A `t.me/+hash` request-to-join link never exposes its peerId until you are approved, so the hash→peer cache can't capture it. Now the invite **title** shown while the link is valid is remembered (`rememberInviteTitle`); when the link later expires, recovery matches that title to an exact known chat — even one you were removed from — before falling back to preview search. Does not recover a link whose title was never seen on this device while valid. `HBOLTSettings.swift`, `JoinLink.swift`.

## Native patch 0054 — Clean Save: keep albums, isolate bad items, retry to ~100%
A 10-item album is atomic server-side: one bad/stale item (e.g. an expired file reference) fails the whole album. On a large unprotected channel this rejected most of the batch (observed 623/1050). Fix: the fast path now uses a **native Telegram forward with drop-author** (`hideNames`) — the same server-side copy as "Forward to Saved Messages (hide sender)", which auto-revalidates file references and preserves original albums (rebuilding messages by media id was failing on stale file references — observed 749/1050 rejected). On an atomic album failure it **binary-splits** the group and retry each half — clean halves go through as smaller albums (8 / 5 / 3 / 2…), the half holding the bad item keeps splitting until that item is alone and routed to re-upload (else counted Rejected). Albums are preserved for every good item; only the actual bad item is isolated. Applies to both the reference fast-path and the re-upload fallback. Additionally, whatever still fails a chunk is **retried up to 4 times** with backoff (full reference + re-upload path on only the remaining failures) before being counted Rejected, so transient issues (a momentary flood/network error, a download that stalled once) don't lose items — open and restricted groups both reach ~100%. `HBOLTBulkForward.swift` (`hboltCleanSaveAlbumRecover`, `hboltCleanSaveSendOnce`, retry loop in `hboltCleanSaveChunk`).

## Native patch 0053 — Clean Save to Saved Messages (bulk)
One-tap "🫧 Clean Save All → Saved Messages" in a chat's Shared Media menu. Saves every photo/video of the chat/topic into the account's own Saved Messages, cleanly (no "forwarded from", no view-once/TTL).

| Requirement | Implementation | Files |
|---|---|---|
| photoVideo only | Server drain of `.photo` + `.video` tags (InputMessagesFilterPhotoVideo), deduped; docs/audio/links/text never captured | `HBOLTBulkForward.swift` (`hboltCleanSaveDrain`) |
| Telegram-to-Telegram, no download | Unprotected items re-sent **by reference** (inputMediaPhoto/Document by id) into Saved Messages as clean 10-item albums — a 50-min 4K video copies server-side | `hboltCleanSaveReferencePass` |
| Scoped bypass, continuous through all chunks, immune to kicks/cancel/drops/rejections | Run is **detached** (not tied to the UI disposable) in `hboltCleanSaveRuns`; one run per account (`tryClaim`); loop advances every chunk until the durable queue is empty, then tears down | `hboltCleanSaveStartRun`, `hboltCleanSaveProcess` |
| Server rejection handling + bounded backoff | Reference-rejected (protected/view-once) items fall back to download + clean re-upload; per-chunk backoff 0.25s→20s, never an infinite spin | `hboltCleanSaveChunk`, `hboltCleanSaveReuploadPass` |
| Auto restore to normal after Done | On empty queue: clear durable file, report, release claim; zero lingering flags | `HBOLTCleanSaveSession.teardown` |
| Durable queue (20k+ survive kick/kill) | Full captured id list + counters persisted to `hbolt-cleansave-<accountId>.json` on start and after every chunk; resumed at launch | `HBOLTCleanSaveStore`, `HBOLTCleanSave.resumeIfNeeded` (AppDelegate) |
| No phantom saved items | Item counts **Verified in Saved** only if present + not `.Failed` after send; server-refused counts **Rejected by Server**; failed Saved bubbles deleted; final counts reported | `hboltCleanSaveChunk`, reference/reupload passes |

Background coverage reuses the 0052 global "any message unsent → keep alive" observer (TelegramCore can't reference the UI keep-alive without a module cycle). Verified here: all 54 patches apply on the pinned commit. Swift compiled on the macOS CI runner.

## Native patch 0052 — user requests after the audit
| Area | Change | Files |
|---|---|---|
| Expired link recovery | Unknown hash (never opened on this device): search the whole account for messages containing it; an invite link preview carries the target chat's title, matched **exactly** against chats the account knows, then opened and remembered | `JoinLink.swift` (`hboltRecoverInvite`) |
| Select all / from here to latest | No cap. Local ids selected instantly, then the complete list is drained from the server (messages.search per media filter, 100/page until empty) and stored like any loaded message, and the selection is extended | `HBOLTBulkSelect.swift` (`allMediaIdsFromServer`, `*Complete`), `ChatInterfaceStateContextMenus.swift`, `PeerInfoScreen.swift` |
| Member activity feed | Waits for the complete shared-group list (pages through all), searches 4 groups at a time, shows results progressively with "Searching X/Y", up to 300 rows | `HBOLTActivityFeed.swift` |
| Account age | Real `registrationDate` from Telegram's peer settings when provided (+ phone country, name/photo change dates); otherwise an updated, clearly-labelled estimate | `PeerInfoProfileItems.swift` |
| Albums-of-10 / View Once | Unprotected source → by reference (no download, works uncached). Protected + not on disk → downloaded first then sent as the album / view-once (was silently degraded to a plain forward) | `HBOLTProtectedForward.swift` |
| Speed (protected path) | Hard links instead of byte copies; Sonic pipeline lets downloads run up to 2 chunks ahead of confirmed uploads; classic "Forward All" uses the same streaming pipeline; deferred units share one serial lane | `HBOLTBulkForward.swift`, `HBOLTProtectedForward.swift` |
| Background | App kept alive while ANY message is unsent on any account (all modes, normal sends too); released when the queue is empty | `AppDelegate.swift`, `HBOLTBackgroundKeepAlive.swift` |

## Native patch 0051 — fixes from the feature audit
| Problem | Fix | Files |
|---|---|---|
| Big videos silently dropped when forwarding from protected chats (hard 180 s download timeout, then the item was skipped with no notice) | Progress-aware wait: gives up only after 5 min with **no progress** while actively downloading, if the fetch fails, or after 3 h; queued downloads are never counted as stalled. Deferred items are sent one unit at a time in original order (no more dozens of parallel downloads starving each other), and any item that still fails is reported in **Saved Messages** | `HBOLTBulkForward.swift` (`hboltFetchUntilCached`), `HBOLTProtectedForward.swift` |
| "Done. Sent…" report was posted into the **target chat** (visible to everyone in a group) | All HBOLT reports go to the user's own Saved Messages, with the target's name | `HBOLTBulkForward.swift` (`hboltReportToSaved`) |
| Bulk forward re-downloaded + re-uploaded everything, even from normal (unprotected) chats | Unprotected sources are re-sent **by reference** (inputMediaPhoto/Document by id): no download, no upload, still albums of 10, no "Forwarded from". Items the server refuses (e.g. kicked from source) are removed and retried automatically via download + re-upload. Protected chats keep the re-upload path | `HBOLTBulkForward.swift` (`hboltReferenceSendRun`) |
| "Select all media" silently selected only what is stored on the device (max 5000) | Selection still instant; then asks the server for the real count and, if larger, tells the user and points to Forward All / Sonic Bulk | `HBOLTBulkSelect.swift` (`serverMediaCount`, `partialSelectionWarning`), `ChatInterfaceStateContextMenus.swift`, `PeerInfoScreen.swift` |
| Ghost Mode still sent read receipts in **secret chats** | `readEncryptedHistory` suppressed when "No read receipts" is on | `SynchronizePeerReadState.swift` |
| Final count said items failed when they had been sent (a sent message gets a new cloud id, so the old lookup by local id missed it) | Count failures (still present + `Failed`) instead of successes | `HBOLTBulkForward.swift` (`hboltDeliveredCount`) |

Verified here: all 52 patches apply cleanly on the pinned Telegram-iOS commit. Swift compile only happens on the macOS CI runner.

## Done in v1.2.0
| Area | Change | Files |
|---|---|---|
| Crisp avatars | Load full-size 640px profile photos (was 160px small → pixelated); avatar cache bumped to v2 | `src/ui/avatar.ts`, `src/style.css` |
| Media tab → viewer | Grid tap can't bubble/navigate; viewer swallows touches, sits above everything, system back closes the viewer only | `src/ui/chatInfo.ts`, `src/features/galleryViewer.ts` |
| Re-lock kept screen | Passcode re-lock after background restores the same screen (+ open viewer) instead of jumping to the chat list | `src/main.ts` |
| Select all | No 20 000 cap — pages (100/request, Telegram's max) until the end | `src/telegram/client.ts` |

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
