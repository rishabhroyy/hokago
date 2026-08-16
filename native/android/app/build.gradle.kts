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

    buildTypes {
        release {
            isMinifyEnabled = false
            // Self-hosted client distributed as sideload APKs: a committed
            // keystore keeps signatures stable across CI runs (upgrades must
            // keep the same signature or Android refuses to install them).
            // An unsigned release APK won't install at all.
            signingConfig = signingConfigs.getByName("release")
        }
    }

    signingConfigs {
        create("release") {
            storeFile = file("hokago-release.keystore")
            storePassword = "hokago-keystore"
            keyAlias = "hokago"
            keyPassword = "hokago-keystore"
            enableV1Signing = true
            enableV2Signing = true
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