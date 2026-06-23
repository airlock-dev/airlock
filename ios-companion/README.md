# Airlock iOS Companion

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

Release from the repo root:

```sh
just ios-testflight
```

The lane uses Xcode automatic signing and uploads `bot.airlock.companion` to TestFlight. By default it uses a UTC timestamp as `CURRENT_PROJECT_VERSION`, so each upload gets a monotonically increasing build number without editing the Xcode project.
