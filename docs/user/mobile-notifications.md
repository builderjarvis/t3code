# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Live Activity Updates** on iOS, **Agent Live Updates** on Android 16 and newer, or **Ongoing Agent Activity** on older Android versions to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off the same switch to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. If Live Updates don't appear on Android 16 or newer, check **Live Update Settings** in T3 Code's **Settings → Notifications**. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. In the released app, background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. Custom iOS builds can instead use self-hosted APNs as described below. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.

## Self-hosted iOS push

An environment can send agent alerts directly through Apple Push Notification
service (APNs), without a T3 Connect account or relay. This requires an iOS build
signed by your own paid Apple Developer team; your credentials cannot send to the
App Store app. Free Personal Team builds do not support push.

1. Create an explicit app identifier with Push Notifications enabled and an APNs
   signing key in your Apple Developer account. Keep the `.p8` file on the server,
   outside the repository, readable only by the server user.
2. Start the environment with all four variables set:

   ```sh
   T3CODE_APNS_TEAM_ID=YOUR_TEAM_ID
   T3CODE_APNS_KEY_ID=YOUR_KEY_ID
   T3CODE_APNS_BUNDLE_ID=com.example.t3code
   T3CODE_APNS_KEY_FILE=/secure/path/AuthKey.p8
   ```

   Export these variables in the environment of the T3 server process (including
   the desktop app's server process, if that is your host), then restart it.
   Partial configuration or an invalid signing key prevents server startup.

3. Build the mobile client with `T3CODE_IOS_BUNDLE_ID=com.example.t3code` in the
   repository-root `.env.local`, using your team's provisioning profile with the
   push entitlement. Do not enable `T3CODE_IOS_PERSONAL_TEAM`. See the
   [mobile build guide](../../apps/mobile/README.md). Use a distinct bundle ID for
   each side-by-side build; configure its matching server accordingly.
4. Pair the mobile app with the environment directly, for example over Tailscale.
   Open **Settings → Notifications → Self-hosted notifications** and enable the
   environment. iOS will ask for notification permission.

Alerts cover completion, failure, approval requests, and input requests. Tapping
an alert opens its thread. Development builds use sandbox APNs; preview and
production builds use production APNs. The server needs outbound HTTP/2 access
to Apple on port 443, but no public inbound port is required. The phone does not
need to remain connected to the environment to receive alerts.

Turn off the environment's switch to unregister it. Revoking its paired session
also stops future delivery; expired sessions must be paired again. Registrations
are stored in the environment's protected secret store. Tokens refresh when the
app returns to the foreground or Apple rotates them; the environment must be
reachable for registration. Disable Connect notifications for the same environment
if you do not want alerts from both delivery paths.

This mode sends ordinary alerts, not Live Activities. Transient delivery failures
are retried three times; it is not a durable notification queue and does not replay
completed work after a server restart. Push payloads contain the thread title,
activity headline, and thread identifiers, not conversation contents. These
payloads go to Apple, not T3 Connect.
