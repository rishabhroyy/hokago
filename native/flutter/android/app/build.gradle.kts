plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.hokago.app"
    // flutter.compileSdkVersion (currently 36, the Flutter SDK's bundled
    // default) is no longer enough — flutter_secure_storage now requires
    // compiling against API 37. Hardcoded until the Flutter template default
    // catches up; compileSdk is backward compatible, doesn't affect minSdk.
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.hokago.app"
        // media_kit's libmpv build + androidx.leanback both want 24+; every
        // real Android TV box and phone in the fleet already clears it.
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        // CI passes -PappVersionName/-PappVersionCode (see .github/workflows/native.yml);
        // pubspec.yaml's version is the local-build default.
        versionCode = (project.findProperty("appVersionCode") as? String)?.toIntOrNull() ?: flutter.versionCode
        versionName = project.findProperty("appVersionName") as? String ?: flutter.versionName
    }

    flavorDimensions += "form"
    productFlavors {
        create("phone") {
            dimension = "form"
            manifestPlaceholders["isTv"] = "false"
        }
        create("tv") {
            dimension = "form"
            manifestPlaceholders["isTv"] = "true"
            applicationIdSuffix = ".tv"
        }
    }

    // The release signing key is never committed — repo secrets in CI
    // (ANDROID_KEYSTORE_BASE64 etc., decoded to a file, see native.yml).
    // Local builds without the env vars fall back to the debug keystore —
    // installable for sideload testing, not a real release signature.
    signingConfigs {
        create("release") {
            val envPath = System.getenv("ANDROID_KEYSTORE_PATH")
            if (envPath != null) {
                storeFile = file(envPath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            } else {
                storeFile = file(System.getProperty("user.home") + "/.android/debug.keystore")
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
            enableV1Signing = true
            enableV2Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // AGP 9's default resource shrinking wants isMinifyEnabled=true
            // (code shrinking) to go with it — explicit false here since we
            // don't ship this with minify on.
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    // TV leanback launcher banner/theme — same as the retired webview shell.
    implementation("androidx.leanback:leanback:1.0.0")
}
