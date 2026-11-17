import fsp from 'node:fs/promises';
import path from 'node:path';
import { ANDROID_DEFAULTS } from './toolchain.mjs';

/**
 * Project templates. Each one is a complete, buildable starting point with:
 *  - the files of the project,
 *  - AGENTS.md telling the coding agent how to build and verify it,
 *  - the SleepPilot checks that prove the work (the Android build itself for Android templates),
 *  - the preview settings (web content is previewed live in the browser while it is written).
 *
 * Versions are pinned (see ANDROID_DEFAULTS) so a project builds the same way next year.
 */
export const PROJECT_TEMPLATES = {
  blank: { id: 'blank', label: 'Existing / blank folder', android: false },
  web: { id: 'web', label: 'Web app (HTML/CSS/JS, live preview)', android: false },
  rust: { id: 'rust', label: 'Rust project (Cargo)', android: false },
  'android-kotlin': { id: 'android-kotlin', label: 'Android app — native Kotlin', android: true },
  'android-webview': { id: 'android-webview', label: 'Android app — HTML/JS in a native shell (preview + APK)', android: true },
  'android-libgdx': { id: 'android-libgdx', label: 'Android 3D game — libGDX (Java)', android: true },
};

const LIBGDX_VERSION = '1.12.1';
const KOTLIN_VERSION = '1.9.24';
const WEBKIT_VERSION = '1.11.0';

/** "Yarış Oyunu 3D" → "com.sleeppilot.yarisoyunu3d" — a valid Java package / application id. */
export function defaultApplicationId(name, prefix = 'com.sleeppilot') {
  const ascii = String(name || 'app')
    .replace(/[ıİ]/g, 'i')
    .replace(/[şŞ]/g, 's')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  let last = ascii.slice(0, 30) || 'app';
  if (!/^[a-z]/.test(last)) last = `app${last}`;
  if (JAVA_KEYWORDS.has(last)) last = `${last}app`;
  return `${prefix}.${last}`;
}

const JAVA_KEYWORDS = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield'.split(' '));

/** Throws when `id` is not a valid Android application id. */
export function validateApplicationId(id) {
  const value = String(id || '').trim();
  const parts = value.split('.');
  if (parts.length < 2 || value.length > 150 || !parts.every((p) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(p) && !JAVA_KEYWORDS.has(p))) {
    throw new Error(`"${value}" is not a valid Android application id. Use at least two dot-separated parts of letters, digits and underscores, each starting with a letter (for example com.example.mygame).`);
  }
  return value;
}

const xmlEscape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": "\\'" }[c]));
const javaString = (s) => JSON.stringify(String(s ?? ''));

const GITIGNORE_ANDROID = `# Gradle / Android build output
.gradle/
build/
**/build/
captures/
.externalNativeBuild/
.cxx/
# Machine-specific: written by SleepPilot / Android Studio with the local SDK path
local.properties
# IDE
.idea/
*.iml
.DS_Store
# Signing keys never belong in the repository (SleepPilot keeps them in its own data folder)
*.jks
*.keystore
keystore.properties
# libGDX natives copied at build time
android/libs/
`;

const GRADLE_PROPERTIES = `# Build settings for this project (written by SleepPilot).
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
`;

const wrapperProperties = (version = ANDROID_DEFAULTS.gradle) => `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;

const settingsGradle = (name, modules) => `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = ${javaString(name)}
${modules.map((m) => `include ':${m}'`).join('\n')}
`;

const iconFiles = (resDir, { foreground = '#FFFFFF', background = '#1D2B53', glyph = 'app' } = {}) => {
  // A simple, original vector glyph per template: a play triangle, a globe or a wheel.
  const paths = {
    app: 'M40,30 L76,54 L40,78 Z',
    web: 'M54,26 A28,28 0 1,0 54.01,26 Z M30,54 L78,54 M54,26 C40,40 40,68 54,82 M54,26 C68,40 68,68 54,82',
    game: 'M54,28 A26,26 0 1,0 54.01,28 Z M54,42 A12,12 0 1,0 54.01,42 Z M54,28 L54,42 M54,66 L54,80 M28,54 L42,54 M66,54 L80,54',
  };
  const d = paths[glyph] || paths.app;
  const stroke = glyph === 'app' ? `android:fillColor="${foreground}"` : `android:strokeColor="${foreground}" android:strokeWidth="5" android:fillColor="#00000000"`;
  return {
    [`${resDir}/drawable/ic_launcher_foreground.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path ${stroke} android:pathData="${d}" />
</vector>
`,
    // Legacy (pre-Android 8) icon: the same glyph on a rounded square.
    [`${resDir}/drawable/ic_launcher.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="48dp" android:height="48dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="${background}" android:pathData="M18,6 L90,6 Q102,6 102,18 L102,90 Q102,102 90,102 L18,102 Q6,102 6,90 L6,18 Q6,6 18,6 Z" />
    <path ${stroke} android:pathData="${d}" />
</vector>
`,
    [`${resDir}/drawable-anydpi-v26/ic_launcher.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`,
    [`${resDir}/values/colors.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${background}</color>
</resources>
`,
  };
};

function agentsMd({ title, buildCommand, apkPath, extra = '' }) {
  return `# Instructions for coding agents

${title}

## Build and verify

- Build the debug APK with: \`${buildCommand}\`
  - Windows: \`${buildCommand.replace(/^\.\/gradlew/, 'gradlew.bat')}\`
- The APK is written to \`${apkPath}\`.
- SleepPilot runs this build after every task ("Android build" check) and only accepts work
  that builds. If the build fails, read the "What went wrong" part of the output and fix the
  cause; never disable the check, delete tests or skip tasks to make it pass.
- If \`gradlew\` is missing, SleepPilot builds with the Gradle it found or downloaded; do not
  try to write \`gradle-wrapper.jar\` by hand.
- JAVA_HOME and ANDROID_HOME are set by SleepPilot when it found a JDK and the Android SDK.
  If the build says the SDK location is not found, \`local.properties\` needs
  \`sdk.dir=<path to the Android SDK>\` (SleepPilot writes it before each build).

## Rules

- Keep \`minSdk\` ${ANDROID_DEFAULTS.minSdk} and \`targetSdk\` ${ANDROID_DEFAULTS.targetSdk} unless the task says otherwise.
- Do not commit build output (\`build/\`), \`local.properties\`, keystores (\`*.jks\`, \`*.keystore\`) or passwords.
- Release signing is done by SleepPilot (Android screen → Release signing); do not put signing
  passwords into Gradle files.
- Everything you add must be original or properly licensed; note third-party assets and their
  licences in README.md.
${extra}`;
}

/** Files of the native Kotlin template. */
function kotlinTemplate({ name, appId }) {
  const pkgPath = appId.split('.').join('/');
  const res = 'app/src/main/res';
  return {
    files: {
      'settings.gradle': settingsGradle(name, ['app']),
      'build.gradle': `// Top-level build file: plugin versions for every module.
plugins {
    id 'com.android.application' version '${ANDROID_DEFAULTS.agp}' apply false
    id 'org.jetbrains.kotlin.android' version '${KOTLIN_VERSION}' apply false
}
`,
      'gradle.properties': `${GRADLE_PROPERTIES}kotlin.code.style=official
`,
      'gradle/wrapper/gradle-wrapper.properties': wrapperProperties(),
      'app/build.gradle': `plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace '${appId}'
    compileSdk ${ANDROID_DEFAULTS.compileSdk}

    defaultConfig {
        applicationId '${appId}'
        minSdk ${ANDROID_DEFAULTS.minSdk}
        targetSdk ${ANDROID_DEFAULTS.targetSdk}
        versionCode 1
        versionName '1.0'
    }

    buildTypes {
        release {
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = '17'
    }
}
`,
      'app/proguard-rules.pro': '# Project-specific ProGuard/R8 rules.\n',
      'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@drawable/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`,
      [`app/src/main/java/${pkgPath}/MainActivity.kt`]: `package ${appId}

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.TextView

class MainActivity : Activity() {
    private var taps = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        taps = savedInstanceState?.getInt(KEY_TAPS) ?: 0
        val counter = findViewById<TextView>(R.id.counter)
        counter.text = getString(R.string.taps, taps)
        findViewById<Button>(R.id.tap).setOnClickListener {
            taps++
            counter.text = getString(R.string.taps, taps)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(KEY_TAPS, taps)
    }

    private companion object {
        const val KEY_TAPS = "taps"
    }
}
`,
      [`${res}/layout/activity_main.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:gravity="center"
    android:orientation="vertical"
    android:padding="24dp">

    <TextView
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="@string/app_name"
        android:textSize="28sp"
        android:textStyle="bold" />

    <TextView
        android:id="@+id/counter"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_marginTop="16dp"
        android:textSize="18sp" />

    <Button
        android:id="@+id/tap"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_marginTop="16dp"
        android:text="@string/tap" />
</LinearLayout>
`,
      [`${res}/values/strings.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xmlEscape(name)}</string>
    <string name="tap">Tap</string>
    <string name="taps">Taps: %1$d</string>
</resources>
`,
      ...iconFiles(res, { glyph: 'app' }),
    },
    module: 'app',
    preview: { mode: 'off' },
  };
}

/** Files of the HTML-in-a-WebView template: the web app lives in web/ and is previewed live. */
function webviewTemplate({ name, appId }) {
  const pkgPath = appId.split('.').join('/');
  const res = 'app/src/main/res';
  return {
    files: {
      'settings.gradle': settingsGradle(name, ['app']),
      'build.gradle': `plugins {
    id 'com.android.application' version '${ANDROID_DEFAULTS.agp}' apply false
}
`,
      'gradle.properties': GRADLE_PROPERTIES,
      'gradle/wrapper/gradle-wrapper.properties': wrapperProperties(),
      'app/build.gradle': `plugins {
    id 'com.android.application'
}

android {
    namespace '${appId}'
    compileSdk ${ANDROID_DEFAULTS.compileSdk}

    defaultConfig {
        applicationId '${appId}'
        minSdk ${ANDROID_DEFAULTS.minSdk}
        targetSdk ${ANDROID_DEFAULTS.targetSdk}
        versionCode 1
        versionName '1.0'
    }

    // The web app in ../web is packaged as the APK's assets: web/index.html → assets/index.html.
    sourceSets {
        main {
            assets.srcDirs = ['src/main/assets', '../web']
        }
    }

    buildTypes {
        release {
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
}

dependencies {
    implementation 'androidx.webkit:webkit:${WEBKIT_VERSION}'
}
`,
      'app/proguard-rules.pro': `# Keep the JavaScript bridge methods.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
`,
      'app/src/main/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:hardwareAccelerated="true"
        android:icon="@drawable/ic_launcher"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|uiMode"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`,
      [`app/src/main/java/${pkgPath}/MainActivity.java`]: `package ${appId};

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Shows the web app from the APK's assets (the project's web/ folder) in a full-screen WebView.
 * Pages are served from https://appassets.androidplatform.net/assets/, so fetch(), ES modules
 * and localStorage behave as on a normal website.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://appassets.androidplatform.net/assets/index.html";
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // Links inside the app stay in the app; nothing else is opened.
                return !"appassets.androidplatform.net".equals(url.getHost());
            }
        });
        setContentView(webView);
        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
`,
      [`${res}/values/strings.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xmlEscape(name)}</string>
</resources>
`,
      ...iconFiles(res, { glyph: 'web', background: '#0F5257' }),
      'web/index.html': webIndex(name, { mobile: true }),
      'web/style.css': WEB_CSS,
      'web/app.js': WEB_JS,
    },
    module: 'app',
    preview: { mode: 'static', root: 'web', entry: 'index.html' },
  };
}

/** Files of the libGDX 3D game template: core/ (game code) + android/ (launcher). */
function libgdxTemplate({ name, appId }) {
  const pkgPath = appId.split('.').join('/');
  const res = 'android/res';
  return {
    files: {
      'settings.gradle': settingsGradle(name, ['android', 'core']),
      'build.gradle': `plugins {
    id 'com.android.application' version '${ANDROID_DEFAULTS.agp}' apply false
}
`,
      'gradle.properties': `${GRADLE_PROPERTIES}gdxVersion=${LIBGDX_VERSION}
`,
      'gradle/wrapper/gradle-wrapper.properties': wrapperProperties(),
      'core/build.gradle': `plugins {
    id 'java-library'
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

dependencies {
    api "com.badlogicgames.gdx:gdx:$gdxVersion"
}
`,
      'android/build.gradle': `plugins {
    id 'com.android.application'
}

android {
    namespace '${appId}'
    compileSdk ${ANDROID_DEFAULTS.compileSdk}

    defaultConfig {
        applicationId '${appId}'
        minSdk ${ANDROID_DEFAULTS.minSdk}
        targetSdk ${ANDROID_DEFAULTS.targetSdk}
        versionCode 1
        versionName '1.0'
    }

    sourceSets {
        main {
            manifest.srcFile 'AndroidManifest.xml'
            java.srcDirs = ['src']
            res.srcDirs = ['res']
            assets.srcDirs = ['../assets']
            jniLibs.srcDirs = ['libs']
        }
    }

    buildTypes {
        release {
            minifyEnabled false
        }
    }
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_11
        targetCompatibility JavaVersion.VERSION_11
    }
}

configurations { natives }

dependencies {
    implementation project(':core')
    implementation "com.badlogicgames.gdx:gdx-backend-android:$gdxVersion"
    natives "com.badlogicgames.gdx:gdx-platform:$gdxVersion:natives-armeabi-v7a"
    natives "com.badlogicgames.gdx:gdx-platform:$gdxVersion:natives-arm64-v8a"
    natives "com.badlogicgames.gdx:gdx-platform:$gdxVersion:natives-x86"
    natives "com.badlogicgames.gdx:gdx-platform:$gdxVersion:natives-x86_64"
}

// Copy libGDX's native .so files into libs/<abi>/ before they are packaged.
tasks.register('copyAndroidNatives') {
    doFirst {
        configurations.natives.copy().files.each { jar ->
            def abi = ['armeabi-v7a', 'arm64-v8a', 'x86_64', 'x86'].find { jar.name.endsWith("natives-\${it}.jar") }
            if (abi != null) {
                def outputDir = file("libs/\${abi}")
                outputDir.mkdirs()
                copy {
                    from zipTree(jar)
                    into outputDir
                    include '*.so'
                }
            }
        }
    }
}
tasks.matching { it.name.contains('merge') && it.name.contains('JniLibFolders') }.configureEach { it.dependsOn 'copyAndroidNatives' }
`,
      'android/AndroidManifest.xml': `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-feature android:glEsVersion="0x00020000" android:required="true" />

    <application
        android:allowBackup="true"
        android:appCategory="game"
        android:icon="@drawable/ic_launcher"
        android:isGame="true"
        android:label="@string/app_name"
        android:theme="@android:style/Theme.NoTitleBar.Fullscreen">
        <activity
            android:name=".AndroidLauncher"
            android:configChanges="keyboard|keyboardHidden|navigation|orientation|screenSize|screenLayout"
            android:exported="true"
            android:screenOrientation="sensorLandscape">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>

</manifest>
`,
      [`android/src/${pkgPath}/AndroidLauncher.java`]: `package ${appId};

import android.os.Bundle;

import com.badlogic.gdx.backends.android.AndroidApplication;
import com.badlogic.gdx.backends.android.AndroidApplicationConfiguration;

/** Starts the game on Android. All game code lives in the core module. */
public class AndroidLauncher extends AndroidApplication {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AndroidApplicationConfiguration config = new AndroidApplicationConfiguration();
        config.useImmersiveMode = true;
        config.useAccelerometer = true;
        config.useCompass = false;
        config.numSamples = 2;
        initialize(new MainGame(), config);
    }
}
`,
      [`core/src/main/java/${pkgPath}/MainGame.java`]: `package ${appId};

import com.badlogic.gdx.ApplicationAdapter;
import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.graphics.Color;
import com.badlogic.gdx.graphics.GL20;
import com.badlogic.gdx.graphics.PerspectiveCamera;
import com.badlogic.gdx.graphics.VertexAttributes.Usage;
import com.badlogic.gdx.graphics.g3d.Environment;
import com.badlogic.gdx.graphics.g3d.Material;
import com.badlogic.gdx.graphics.g3d.Model;
import com.badlogic.gdx.graphics.g3d.ModelBatch;
import com.badlogic.gdx.graphics.g3d.ModelInstance;
import com.badlogic.gdx.graphics.g3d.attributes.ColorAttribute;
import com.badlogic.gdx.graphics.g3d.environment.DirectionalLight;
import com.badlogic.gdx.graphics.g3d.utils.ModelBuilder;
import com.badlogic.gdx.utils.Array;

/**
 * Starting point: a lit 3D scene built from code (no downloaded assets).
 * Tap the screen to change the cube's colour. Replace this with the real game.
 */
public class MainGame extends ApplicationAdapter {
    private static final long ATTRS = Usage.Position | Usage.Normal;
    private PerspectiveCamera camera;
    private ModelBatch batch;
    private Environment environment;
    private final Array<Model> models = new Array<>();
    private final Array<ModelInstance> instances = new Array<>();
    private ModelInstance cube;
    private float angle;
    private int colorIndex;
    private final Color[] palette = { Color.CORAL, Color.SKY, Color.LIME, Color.GOLD, Color.VIOLET };

    @Override
    public void create() {
        batch = new ModelBatch();
        environment = new Environment();
        environment.set(new ColorAttribute(ColorAttribute.AmbientLight, 0.45f, 0.45f, 0.5f, 1f));
        environment.add(new DirectionalLight().set(0.9f, 0.9f, 0.85f, -0.6f, -1f, -0.4f));

        camera = new PerspectiveCamera(67, Gdx.graphics.getWidth(), Gdx.graphics.getHeight());
        camera.position.set(6f, 5f, 6f);
        camera.lookAt(0, 0.5f, 0);
        camera.near = 0.1f;
        camera.far = 200f;
        camera.update();

        ModelBuilder builder = new ModelBuilder();
        Model cubeModel = builder.createBox(2f, 2f, 2f, new Material(ColorAttribute.createDiffuse(palette[0])), ATTRS);
        Model ground = builder.createBox(30f, 0.2f, 30f, new Material(ColorAttribute.createDiffuse(new Color(0.18f, 0.32f, 0.22f, 1f))), ATTRS);
        models.addAll(cubeModel, ground);
        cube = new ModelInstance(cubeModel, 0, 1.2f, 0);
        instances.add(cube);
        instances.add(new ModelInstance(ground, 0, -0.1f, 0));
    }

    @Override
    public void resize(int width, int height) {
        camera.viewportWidth = width;
        camera.viewportHeight = height;
        camera.update();
    }

    @Override
    public void render() {
        float delta = Math.min(Gdx.graphics.getDeltaTime(), 1 / 20f);
        if (Gdx.input.justTouched()) {
            colorIndex = (colorIndex + 1) % palette.length;
            ((ColorAttribute) cube.materials.get(0).get(ColorAttribute.Diffuse)).color.set(palette[colorIndex]);
        }
        angle = (angle + 45f * delta) % 360f;
        cube.transform.setToRotation(0, 1, 0, angle).trn(0, 1.2f, 0);

        Gdx.gl.glViewport(0, 0, Gdx.graphics.getBackBufferWidth(), Gdx.graphics.getBackBufferHeight());
        Gdx.gl.glClearColor(0.53f, 0.74f, 0.92f, 1f);
        Gdx.gl.glClear(GL20.GL_COLOR_BUFFER_BIT | GL20.GL_DEPTH_BUFFER_BIT);
        batch.begin(camera);
        batch.render(instances, environment);
        batch.end();
    }

    @Override
    public void dispose() {
        batch.dispose();
        for (Model m : models) m.dispose();
    }
}
`,
      'assets/README.txt': 'Game assets (textures, sounds, music, fonts) go here. Only original or properly licensed files.\n',
      [`${res}/values/strings.xml`]: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${xmlEscape(name)}</string>
</resources>
`,
      ...iconFiles(res, { glyph: 'game', background: '#7A1F2B' }),
    },
    module: 'android',
    preview: { mode: 'off' },
  };
}

function webIndex(name, { mobile = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1${mobile ? ', viewport-fit=cover, user-scalable=no' : ''}">
  <title>${xmlEscape(name).replace(/\\'/g, '&#39;')}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="app">
    <h1>${xmlEscape(name).replace(/\\'/g, '&#39;')}</h1>
    <p class="lead">Edit <code>${mobile ? 'web/' : ''}index.html</code>, <code>style.css</code> and <code>app.js</code>. The SleepPilot preview reloads on every save.</p>
    <button id="tap" type="button">Tap</button>
    <p id="count" aria-live="polite">Taps: 0</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
}

const WEB_CSS = `:root {
  color-scheme: light dark;
  --bg: #f4f6fb;
  --fg: #1b2333;
  --accent: #1a73e8;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #11151f; --fg: #e8ecf4; --accent: #8ab4ff; }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}
.app { max-width: 560px; margin: 0 auto; padding: 32px 20px; text-align: center; }
.lead { opacity: .8; }
button {
  font: inherit; font-weight: 600; padding: 14px 28px; border: 0; border-radius: 12px;
  background: var(--accent); color: #fff; touch-action: manipulation;
}
button:active { transform: scale(.97); }
`;

const WEB_JS = `'use strict';

let taps = Number(localStorage.getItem('taps') || 0);
const count = document.getElementById('count');
const render = () => (count.textContent = 'Taps: ' + taps);
document.getElementById('tap').addEventListener('click', () => {
  taps += 1;
  localStorage.setItem('taps', String(taps));
  render();
});
render();
`;

function webTemplate({ name }) {
  return {
    files: { 'index.html': webIndex(name), 'style.css': WEB_CSS, 'app.js': WEB_JS, '.gitignore': 'node_modules/\ndist/\n.DS_Store\n' },
    preview: { mode: 'static', root: '', entry: 'index.html' },
    agents: `# Instructions for coding agents

This is a static web app (HTML/CSS/JavaScript, no build step). The user watches it in the
SleepPilot live preview, which reloads on every saved file.

- Keep it working by opening \`index.html\` from a plain static file server: relative paths only,
  no build tools unless the task asks for them.
- Do not leave JavaScript errors in the console: SleepPilot opens the page in a headless browser
  after each task and fails the task on uncaught errors and failed requests.
`,
    checks: [{ id: 'html-smoke', type: 'html-smoke', name: 'HTML load and JavaScript error check', entries: ['index.html'], enabled: true, approved: true, timeoutSec: 60 }],
    rules: 'Static web app. Keep index.html loadable from a plain file server with no console errors.',
  };
}

/** Gradle task that builds the debug APK of a module ('' = root project). */
export const assembleTask = (module, variant = 'debug', kind = 'apk') => `${module ? `:${module}:` : ''}${kind === 'aab' ? 'bundle' : 'assemble'}${variant[0].toUpperCase()}${variant.slice(1)}`;

/**
 * Write a template into `dir`. Existing files are never overwritten (a template applied to a
 * folder that already has content only adds what is missing) — the result lists skipped files.
 */
export async function scaffoldTemplate(dir, templateId, { name, applicationId } = {}) {
  const template = PROJECT_TEMPLATES[templateId];
  if (!template || templateId === 'blank' || templateId === 'rust') throw new Error(`Unknown template: ${templateId}`);
  const displayName = String(name || path.basename(dir)).trim().slice(0, 80) || 'My App';
  let spec;
  let appId = null;
  if (template.android) {
    appId = validateApplicationId(applicationId || defaultApplicationId(displayName));
    spec = templateId === 'android-kotlin' ? kotlinTemplate({ name: displayName, appId }) : templateId === 'android-webview' ? webviewTemplate({ name: displayName, appId }) : libgdxTemplate({ name: displayName, appId });
    const task = assembleTask(spec.module);
    const apkDir = `${spec.module}/build/outputs/apk/debug/`;
    spec.files['.gitignore'] = GITIGNORE_ANDROID;
    spec.files['AGENTS.md'] = agentsMd({
      title: `This is an Android ${templateId === 'android-libgdx' ? 'game made with libGDX (game code in core/, Android launcher in android/)' : templateId === 'android-webview' ? 'app whose user interface is the web app in web/ (HTML/CSS/JS), shown in a WebView. Build the app as a web app first — it is previewed live in SleepPilot — and keep it working inside the Android WebView (touch input, no hover-only controls, no external CDNs: the APK must work offline).' : 'app written in Kotlin.'}`,
      buildCommand: `./gradlew ${task}`,
      apkPath: apkDir,
      extra: templateId === 'android-libgdx' ? '- Game logic goes in core/ (plain Java, no Android APIs) so it stays testable; android/ only starts the game.\n- Create 3D content, sound and music from code or ship original assets in assets/.\n' : '',
    });
    spec.files['README.md'] = `# ${displayName}

Android ${templateId === 'android-libgdx' ? 'game (libGDX)' : 'app'} created with SleepPilot.

## Build

\`\`\`sh
./gradlew ${task}
\`\`\`

The APK is written to \`${apkDir}\`. In SleepPilot open **Android** to build, sign, install it
on a connected phone (USB debugging) or download it to the phone.
`;
    spec.checks = [{ id: 'android-build', type: 'android-build', name: `Android build (${task})`, module: spec.module, variant: 'debug', enabled: true, approved: true, timeoutSec: 2400 }];
    spec.rules = `Android project (${template.label}). Every task must leave the project building with \`${task}\`; SleepPilot runs that build after each task. Application id: ${appId}.`;
    if (templateId === 'android-webview') spec.checks.push({ id: 'html-smoke', type: 'html-smoke', name: 'Web app load and JavaScript error check', entries: ['web/index.html'], enabled: true, approved: true, timeoutSec: 60 });
  } else {
    spec = webTemplate({ name: displayName });
    spec.files['AGENTS.md'] = spec.agents;
  }
  const written = [];
  const skipped = [];
  for (const [rel, content] of Object.entries(spec.files)) {
    const file = path.join(dir, ...rel.split('/'));
    if (await fsp.stat(file).catch(() => null)) {
      skipped.push(rel);
      continue;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
    written.push(rel);
  }
  return {
    template: templateId,
    applicationId: appId,
    module: spec.module || null,
    written,
    skipped,
    checks: spec.checks || [],
    rules: spec.rules || '',
    preview: spec.preview || null,
    kind: template.android ? 'android' : templateId,
  };
}
