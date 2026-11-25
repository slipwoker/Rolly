# ROLLY on the iPhone — build and install (owner's Mac)

The app contains no API keys. It talks only to `https://rolly-api.onrender.com`.

## 1. Get the code
```bash
git clone https://github.com/slipwoker/Rolly.git rolly-phase1 && cd rolly-phase1
git checkout claude/great-franklin-c07no6
npm ci
cd apps/mobile
```

## 2. Create the Expo project (once)
```bash
npx eas-cli@latest login            # your existing Expo account
npx eas-cli@latest init             # creates the "rolly" project and writes extra.eas.projectId into app.json
```
Bundle identifier: `com.zappy.rolly` in `app.json` (change it there if you prefer another one, before the first build).
Commit and push the `app.json` change (or send me the project id and I will add it).

## 2b. Enrollment key (once; no sign-in screen in the app)
The app has no login screen. On first launch it registers the phone silently with a build key (the server refuses it
otherwise and stops at 5 users). Generate one value and put it in three places:
```bash
openssl rand -hex 24
```
- Render → rolly-api → Environment: `ROLLY_ENROLLMENT_KEY=<value>`
- On the Mac, `apps/mobile/.env.local` (git-ignored): `EXPO_PUBLIC_ROLLY_ENROLLMENT_KEY=<value>` (used by the development build,
  whose JS comes from the Mac)
- For the preview build: `npx eas-cli@latest env:create --name EXPO_PUBLIC_ROLLY_ENROLLMENT_KEY --value <value> --environment preview --visibility sensitive`

## 3. Development build (iteration; JS served from the Mac)
```bash
npx eas-cli@latest device:create    # only if this iPhone is not registered in your Apple team yet
npx eas-cli@latest build --profile development --platform ios
```
EAS asks for the Apple login the first time for this bundle id and creates the provisioning profile with your registered
devices. Install from the link/QR on the iPhone. Developer Mode must be on (Settings → Privacy & Security).
Then on the Mac, same Wi-Fi as the phone:
```bash
npx expo start --dev-client
```

## 4. Preview build (car tests; JS inside the app, no Mac needed)
```bash
npx eas-cli@latest build --profile preview --platform ios
```

## 5. First launch
- The app opens on the conversation screen; it registers itself in the background.
- Start → allow the microphone. The first conversation is the getting-to-know-you one.

## If the build fails
The Swift audio module (`modules/rolly-audio/ios/RollyAudioModule.swift`) has not been compiled before. Send the
"Run fastlane"/"Xcode build" error lines from the EAS build log.

## What to test on the phone (in this order)
1. Wi-Fi, phone unlocked, speaker: a conversation of a few minutes, interrupt ROLLY mid-sentence.
2. Lock the phone during the conversation: does it continue? (check after 1, 5, 30 minutes)
3. Mobile data instead of Wi-Fi.
4. In the parked car with Bluetooth: connect, talk, lock, switch Bluetooth off and on, receive a call.
The app reports reply times and audio-route events to the server; I read them from there.
