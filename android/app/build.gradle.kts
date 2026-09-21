import java.util.Properties

plugins { id("com.android.application") }

android {
    namespace = "kr.ac.roi.viewer"
    compileSdk = 36
    defaultConfig {
        applicationId = "kr.ac.roi.viewer"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    val keys = Properties().apply {
        val source = rootProject.file("keys/signing.properties")
        if (source.exists()) source.inputStream().use { load(it) }
    }
    signingConfigs {
        create("research") {
            storeFile = rootProject.file("keys/research.jks")
            storePassword = keys.getProperty("password", "")
            keyAlias = "roi"
            keyPassword = storePassword
        }
    }
    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("research") }
        getByName("release") {
            signingConfig = signingConfigs.getByName("research")
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
}

dependencies { implementation("androidx.webkit:webkit:1.14.0") }
