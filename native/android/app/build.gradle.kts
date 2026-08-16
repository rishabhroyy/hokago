plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.hokago.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.hokago.app"
        minSdk = 24
        targetSdk = 35
        // Versions come from CI (-PappVersionName / -PappVersionCode); the
        // gradle.properties keys are the local defaults. Read via
        // project.findProperty — top-level `val` declarations with explicit
        // types trip Gradle's generated-accessor conflict in the Kotlin DSL.
        versionCode = (project.findProperty("appVersionCode") as? String)?.toIntOrNull() ?: 1
        versionName = project.findProperty("appVersionName") as? String ?: "0.3.0"
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
        }
    }

    // The release signing key is NEVER committed — it lives in GitHub repo
    // secrets (CI decodes ANDROID_KEYSTORE_BASE64 to a file and points
    // ANDROID_KEYSTORE_PATH at it). The APK signature is Android's trust
    // anchor: a leaked key lets anyone ship malicious updates over the
    // install base. Local builds fall back to the well-known debug keystore
    // so `assembleRelease` still yields an installable APK without the
    // official key (that signature is only valid for local sideloads).
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
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    sourceSets {
        // Bundled SPA for offline mode lives under src/main/assets/web-dist
        // (CI copies apps/web/dist there; .gitkeep keeps the dir in the repo).
        getByName("main").assets.srcDirs("src/main/assets")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.lifecycle)
    implementation(libs.androidx.leanback)
    implementation(libs.androidx.media)
}