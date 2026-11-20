# Workspace, live preview and Android APKs

This guide covers three features that work together: the **workspace** (where projects live),
the **live preview** (watch a web app being written), and **Android builds** (from a template
or an existing project to an APK on your phone).

## Workspace

**Settings → Workspace** (or the card on the Home screen) chooses one folder for all your
SleepPilot projects. SleepPilot creates this layout inside it and never overwrites anything that
is already there:

```text
<workspace>/
  sleeppilot-workspace.json   marker file (layout version)
  README.md                   explains the folders
  projects/<name>/            one folder per project — the agents work here
  exports/<name>/             APKs and AABs copied here after every successful build
```

With a workspace, **Home → New project** needs only a name. The folder name is made safe for
build tools: `Yarış Oyunu 3D` becomes `projects/yaris-oyunu-3d`, and a second project with the
same name gets `-2`. Gradle and the Android SDK fail on spaces and non-ASCII characters in a
path, so choose a short workspace path too (for example `C:\SleepPilot`).

Folders you copy into `projects/` by hand appear on the Home screen as *not opened yet*; **Open as
project** registers them. Existing projects outside the workspace keep working where they are.

Run history, settings and API keys are **not** stored in the workspace; they stay in SleepPilot's
data folder (`%LOCALAPPDATA%\SleepPilot`).

## Project templates

| Template | What you get | Checks | Preview |
|---|---|---|---|
| Web app | `index.html`, `style.css`, `app.js` | page load + JavaScript errors | static, live reload |
| Android — native Kotlin | Gradle project, `app/` module, one activity | Android build | — |
| Android — HTML/JS in a native shell | the web app in `web/`, packaged into a WebView app | Android build + page load | `web/`, live reload |
| Android 3D game — libGDX | `core/` (game, plain Java) + `android/` (launcher), a lit 3D scene built from code | Android build | — |
| Rust | Cargo crate | `cargo check`, `cargo test` | — |

Every Android template pins its versions (Android Gradle Plugin 8.5.2, Gradle 8.9, compile/target
SDK 34, min SDK 24), writes an `AGENTS.md` that tells the coding agent how to build and verify,
and adds a `.gitignore` that keeps build output, `local.properties` and keystores out of Git.
The application id is made from the name (`com.sleeppilot.yarisoyunu3d`) unless you enter one.

When a Gradle installation is available, **Add the Gradle wrapper** runs `gradle wrapper` once
(in an empty folder, so the Android build is not configured and nothing is downloaded for it).
Without a wrapper SleepPilot builds with the Gradle it found or downloaded.

## Live preview

The **Preview** screen shows the project's web app in a phone, tablet or desktop frame while the
agent writes it.

- **Static preview**: the project folder (or a sub-folder such as `public/`, `dist/`, `web/`) is
  served read-only on `127.0.0.1`. Pages reload by themselves when a file changes (style sheets are
  swapped without a reload). JavaScript errors, failed requests and `console.error` calls of the
  page appear in the **Console** panel.
- **Dev server**: projects built by Vite, Next.js, webpack, Astro … need their own server. The
  preview starts the command (`npm run dev` by default) and reads the address it prints. The
  command runs project code, so it only starts after you tick *I approve running this command*;
  changing the command withdraws the approval.

*Auto* chooses what fits: a bundler with a dev script → dev server; an `index.html` → static. When
a run starts, a static preview starts by itself (turn this off in the preview settings). Finished
projects can be previewed the same way at any time.

Security: the preview runs on its own port (a different origin from the SleepPilot window), answers
only loopback host names, serves no dot-files (`.env`, `.git`) and follows no link out of the
served folder. The phone cannot open the preview (it runs on the PC); APKs can be downloaded to the
phone instead.

## Android builds

The **Android** screen has everything from a Gradle project to an installed app.

### Toolchain

SleepPilot finds what Android Studio installs, without PATH changes or system variables:

- **JDK 17+**: Android Studio's bundled `jbr`, then `JAVA_HOME`, Temurin/Oracle/Microsoft/Zulu/
  Corretto installs, `~/.jdks`.
- **Android SDK**: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `%LOCALAPPDATA%\Android\Sdk` (and the macOS/
  Linux defaults). Platforms, build-tools, platform-tools (`adb`), licence status are read from
  the folder.
- **Gradle** (only for projects without `gradlew`): a SleepPilot download, `GRADLE_HOME`, PATH,
  Scoop/Chocolatey, the wrapper cache.

Each missing piece is listed with the exact fix. Paths can be set by hand under
**Settings → Android**. The detected JDK and SDK are also given to agent turns (`JAVA_HOME`,
`ANDROID_HOME`), so `gradlew` works from the agent's shell too.

**Download Gradle** fetches the official distribution from `services.gradle.org` into SleepPilot's
tools folder, only when you click it. The archive's SHA-256 must match the checksum Gradle
publishes, or nothing is installed. Behind a company proxy, download the zip by hand and set its
`bin/gradle(.bat)` under Settings → Android.

### Building

- **Debug APK**, **Release APK**, **Release AAB (Play)** run `assembleDebug`, `assembleRelease` or
  `bundleRelease` on the app module, with the detected JDK and SDK. `local.properties` is written
  with the SDK path when it is missing.
- The log streams live; a failure is summarised from Gradle's *What went wrong* block with a
  concrete hint (SDK not found, licences, Java version, no internet for dependencies, compile or
  resource errors, Gradle/AGP version mismatch, memory).
- The produced APK/AAB is opened and checked: package name, version, SDK levels, launcher activity,
  ABIs, signature scheme (v1 / v2+). Successful builds are copied to
  `<workspace>/exports/<project>/<name>-<version>-<variant>.apk`.

### Every task is verified by a real build

Android templates add the **Android build** check (also available for imported projects via
*Verify every task with an Android build*). After each task SleepPilot runs the Gradle build and
only accepts the task when an APK is produced. A machine without a JDK/SDK reports the check as
an environment error, not as a broken task.

### Does the app start? (run check)

*Also start the app after each build* adds the **Android run** check after the build check. It installs
the newest debug APK, starts it from its launcher icon, waits a few seconds and fails the task when the
app crashed (the stack trace from the device log goes to the developer) or is no longer running. One
screenshot of the device is saved to `.sleeppilot/screens/`; the reviewer can open it.

The device is a USB phone with USB debugging (first choice) or a running emulator. When none is
connected and an emulator image exists (Android Studio → Device Manager), SleepPilot starts it without a
window, waits until Android has booted, keeps it running for the following checks and stops it when
SleepPilot closes. No device and no emulator image is reported as an environment problem, not as a
broken task.

### Release signing

**Create release key** makes a 4096-bit RSA key with the JDK's `keytool`, valid for 30 years. The
keystore is stored in SleepPilot's data folder (`android-keys/`), never in the project; its random
password is kept in the credential file and is redacted from every log. Release builds receive the
key through Gradle's `android.injected.signing.*` properties, as Android Studio does. SleepPilot
never replaces an existing key: phones and Google Play only accept updates signed with the same
key, so **back up the keystore file**.

### Getting the app onto a phone

- **USB**: enable USB debugging on the phone, connect it, click **Look for devices**, then
  **Install & run** next to an APK. Install errors are explained (different signature, older
  Android, not authorised, no space). **Show recent errors (logcat)** shows the device's error log,
  filtered to the app.
- **Download**: the **Download** button saves the APK. Opened from the phone (Settings → Phone), it
  downloads straight to the phone; allow *Install unknown apps* for the browser once.

## Frameworks

Gradle projects in a sub-folder are found too: Flutter, React Native, Capacitor/Cordova (`android/`)
and libGDX. Godot projects are recognised (export presets), but their APK is exported from Godot.
