plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

// Build output outside the repo on Windows (the repo is in OneDrive, under a non-ASCII folder name).
System.getenv("LOCALAPPDATA")?.let { local ->
    allprojects { layout.buildDirectory.set(file("$local/NoviPhoneBuild/${project.name}")) }
}
