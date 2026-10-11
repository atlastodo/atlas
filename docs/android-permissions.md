# Android permissions

Every permission the Android app declares, and why. The release build checks its merged manifest
against the table below (`apps/mobile/scripts/check-android-permissions.mjs`), so a dependency
update that adds a permission fails the release instead of reaching users. To accept a new one,
add a row here; to drop one, add it to `android.blockedPermissions` in `apps/mobile/app.json` and
remove its row.

Check a local build with `android:permissions` (after `build:android:local`,
`bundle:android:release` or any Gradle release build).

## Declared

| Permission                                                  | Asked for                                                            | What it is for                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android.permission.INTERNET`                               | No (granted at install)                                              | Syncing with your server.                                                                                                                                                                                                                                                                                                                                                                             |
| `android.permission.ACCESS_NETWORK_STATE`                   | No (granted at install)                                              | Telling "the device is offline" apart from "the server is down".                                                                                                                                                                                                                                                                                                                                      |
| `android.permission.POST_NOTIFICATIONS`                     | Yes, Android 13+                                                     | Reminders and the focus timer's phase-end alert. Asked only after the app explains why (the permissions drawer after onboarding, or when you turn reminders on or add one). Everything else works without it.                                                                                                                                                                                         |
| `android.permission.SCHEDULE_EXACT_ALARM`                   | Android 12 only: on by default, can be turned off in system settings | Reminders firing on time on Android 12, where `USE_EXACT_ALARM` does not exist. Android 12 grants it by default; if it is turned off, the permissions drawer links to the "Alarms & reminders" page. Without exact alarms Android delivers reminders late (Doze can hold them back about 10 minutes).                                                                                                 |
| `android.permission.USE_EXACT_ALARM`                        | No (granted at install, Android 13+)                                 | Reminders firing on time on Android 13+ without a trip to system settings. Google Play restricts it to apps whose core feature is precisely timed, and needs a declaration in the Play Console: reminders at a time the user picked are the app's core feature. If Play refuses it, remove this row and the `app.json` entry; `SCHEDULE_EXACT_ALARM` covers Android 13+ again, asked for in settings. |
| `android.permission.RECEIVE_BOOT_COMPLETED`                 | No (granted at install)                                              | Re-booking scheduled reminders after a reboot or an app update (expo-notifications).                                                                                                                                                                                                                                                                                                                  |
| `android.permission.VIBRATE`                                | No (granted at install)                                              | Haptic feedback.                                                                                                                                                                                                                                                                                                                                                                                      |
| `android.permission.WAKE_LOCK`                              | No (granted at install)                                              | Required by libraries the app ships: the audio player behind the focus timer's chime (Media3 ExoPlayer) and Firebase Cloud Messaging, which expo-notifications bundles. The app does not use push.                                                                                                                                                                                                    |
| `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | No (internal to the app)                                             | AndroidX's signature permission that keeps the app's runtime-registered receivers private to it.                                                                                                                                                                                                                                                                                                      |

## Removed

Dependencies declare these, but the app does not use what they guard, so `app.json` strips them
(`android.blockedPermissions`):

- Storage (`READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`): attachments go through the system
  file picker, which needs no permission.
- Audio (`RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`): the app only
  plays a short chime, in the foreground.
- `SYSTEM_ALERT_WINDOW`: a development-build overlay.
- `ACCESS_WIFI_STATE`: only expo-network's IP-address lookup uses it.
- `USE_BIOMETRIC`, `USE_FINGERPRINT`: expo-secure-store's biometric unlock, which the app does not
  use.
- `com.google.android.c2dm.permission.RECEIVE`: receiving push messages. Reminders are local
  notifications; the app has no push.
- `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`: Play's install-referrer
  (install attribution), pulled in through expo-application.
- Launcher badge permissions (Samsung, HTC, Sony, Huawei, OPPO and others, plus `READ_APP_BADGE`):
  ShortcutBadger's, bundled with expo-notifications. The app sets no badge count.
