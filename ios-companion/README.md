# Airlock iOS Companion

## Notification cleanup QA

For the notification lifecycle and its delivery limitations, see the
[iOS provider reference](../docs/reference/hitl-providers.md#ios-companion).
Run these checks with a development gateway and a registered physical iPhone;
a simulator build alone does not verify APNs background delivery. Use disposable
approvals and keep one unrelated pending approval and one activity notification
visible to verify that cleanup is selective.

- **Foreground sync:** resolve an approval from the dashboard, macOS companion,
  or CLI. Refresh the iOS queue and verify its delivered notification disappears,
  the other pending approval and activity remain, and the badge matches the queue.
  Repeat with history or activity returning an error while the queue succeeds.
- **Background resolution:** background the app and resolve an approval elsewhere.
  Confirm receipt of `event: approval_resolved` through a debugger or device logs;
  verify cleanup completes before the background fetch completion handler runs.
  Repeat for approve, deny, timeout, and cancellation. The push must have
  `apns-push-type: background`, priority `5`, and only `content-available: 1` in `aps`.
- **Missed push:** force quit the app, resolve approvals elsewhere, then launch it.
  A successful queue sync must remove the stale notifications. Repeat by resuming
  a backgrounded app after a missed push. Delivery while force quit is not required.
- **Idempotency and mapping:** clear an approval notification manually, then deliver
  its resolution event twice. Both runs must succeed without affecting other
  notifications. Also test a resolution payload containing only the approval code.
- **Offline handling:** make the management API unreachable and deliver a resolution
  event. Its matching notification must still be removed; other notifications must
  remain. Restore connectivity and refresh to reconcile the rest of the queue.
- **Stale actions:** preserve an old notification while resolving its approval
  elsewhere. Try Approve, Deny, Allow 1 Hour, and Always Allow separately. Settings
  should report "Approval already resolved."; no second decision or permission
  change should occur. Repeat with resolution between the pending check and POST
  to exercise the server's `409` response.
- **Arrival during sync:** delay the queue response, deliver a new approval alert,
  then finish the older queue response. The new notification must survive until
  a later sync has authoritative state for it.

Local validation commands (from the repository root):

```sh
npx vitest run test/apns.test.ts test/mobile-api.test.ts test/hitl.test.ts
xcodebuild -project ios-companion/AirlockCompanionIOS.xcodeproj \
  -scheme AirlockCompanionIOS -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/airlock-ios-build CODE_SIGNING_ALLOWED=NO build
```

## Local TestFlight Release

This repo intentionally does not publish the iOS companion from public CI. The release lane is local: it builds and uploads from your Mac, while App Store Connect credentials stay in `ios-companion/.env.local`.

One-time setup:

```sh
just ios-testflight-setup
cd ios-companion
cp .env.example .env.local
```

The setup recipe installs gems into `ios-companion/vendor/bundle`, so it does not require sudo or system RubyGems access.

Fill `.env.local` with an App Store Connect API key and `AIRLOCK_IOS_TEAM_ID`. Keep the `.p8` key outside the repo and point `APP_STORE_CONNECT_API_KEY_PATH` at its absolute path.

If the key is in 1Password under `Personal/Apple Dev Connect Fastlane CI key Airlock`, generate the local env file from the repo root:

```sh
just ios-testflight-env
```

That recipe writes `ios-companion/.env.local` and an ignored local `.p8` file under `ios-companion/.appstoreconnect/`.

Before the first upload, fill `AIRLOCK_IOS_TEAM_ID` in `.env.local` with the startup org's 10-character Apple Developer Team ID. Xcode needs this to create App Store provisioning profiles for the app and notification extension.

To add every uploaded build to an internal TestFlight group automatically, set the exact group name in `.env.local`:

```sh
AIRLOCK_IOS_TESTFLIGHT_GROUPS=Your Group Name
```

Multiple groups can be comma-separated. When this is set, the release command waits for Apple to finish processing the build, then attaches it to the group.

The lane does not submit builds for external beta review. Use the existing internal groups for private releases.

Release from the repo root:

```sh
just ios-testflight
```

The lane uses Xcode automatic signing and uploads `bot.airlock.companion` to TestFlight. By default it uses a UTC timestamp as `CURRENT_PROJECT_VERSION`, so each upload gets a monotonically increasing build number without editing the Xcode project.

If export fails with `Copy failed` and the distribution log reports an `rsync` extended-attributes error, put Apple's tools before Homebrew's for this command:

```sh
PATH=/usr/bin:/bin:/usr/sbin:/sbin:$PATH just ios-testflight
```
