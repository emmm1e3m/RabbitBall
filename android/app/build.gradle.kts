import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

plugins { id("com.android.application") }

// 富文本规则始终取自 PC 源码，避免两端分别维护 Markdown、公式和来源图标。
abstract class SyncPcRichText : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceFile: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val destination = outputDirectory.file("conversation/rich-text.js").get().asFile
        destination.parentFile.mkdirs()
        sourceFile.get().asFile.copyTo(destination, overwrite = true)
    }
}

val syncPcRichText = tasks.register<SyncPcRichText>("syncPcRichText") {
    sourceFile.set(rootProject.layout.projectDirectory.file("../windows/prototype/rich-text.js"))
    outputDirectory.set(layout.buildDirectory.dir("generated/pc-rich-text"))
}

androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(syncPcRichText, SyncPcRichText::outputDirectory)
}

android {
    namespace = "com.rabbitball.app"
    compileSdk { version = release(36) { minorApiLevel = 1 } }
    defaultConfig {
        applicationId = "com.rabbitball.app"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "com.rabbitball.app.AiSmokeInstrumentation"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes {
        release { isMinifyEnabled = false }
    }
}

