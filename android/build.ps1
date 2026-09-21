param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Push-Location $PSScriptRoot
try {
    $java = (Get-Command javac.exe -ErrorAction Stop).Source
    $env:JAVA_HOME = Split-Path (Split-Path $java)
    $env:GRADLE_USER_HOME = Join-Path $PSScriptRoot '.tools/gradle-home'
    $env:ANDROID_HOME = Join-Path $PSScriptRoot '.tools/sdk'
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    New-Item -ItemType Directory -Force .tools, keys, dist | Out-Null

    if ($Setup) {
        if (-not (Test-Path '.tools/sdk/cmdline-tools/latest/bin/sdkmanager.bat')) {
            $archive = '.tools/commandline-tools.zip'
            if (-not (Test-Path $archive)) {
                Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' -OutFile $archive
            }
            if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a') {
                throw 'Android command-line tools checksum mismatch.'
            }
            Expand-Archive -LiteralPath $archive -DestinationPath '.tools/sdk-extract' -Force
            New-Item -ItemType Directory -Force '.tools/sdk/cmdline-tools/latest' | Out-Null
            Copy-Item -Path '.tools/sdk-extract/cmdline-tools/*' -Destination '.tools/sdk/cmdline-tools/latest' -Recurse -Force
        }
        # Explicit ASCII stdin avoids PowerShell's native-pipeline encoding differences.
        Set-Content -LiteralPath '.tools/sdk-answers.txt' -Value 'y' -Encoding ASCII
        $sdkArgs = @('-classpath', '.tools/sdk/cmdline-tools/latest/lib/sdkmanager-classpath.jar',
            'com.android.sdklib.tool.sdkmanager.SdkManagerCli', ('--sdk_root="' + $env:ANDROID_HOME + '"'),
            'platforms;android-36', 'build-tools;36.0.0', 'platform-tools')
        $install = Start-Process -FilePath "$env:JAVA_HOME/bin/java.exe" -ArgumentList $sdkArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardInput '.tools/sdk-answers.txt' -RedirectStandardOutput '.tools/sdk-install.log' -RedirectStandardError '.tools/sdk-install-errors.log'
        if ($install.ExitCode -ne 0) { throw 'Android SDK installation failed; see .tools/sdk-install-errors.log.' }
    }
    if (-not (Test-Path '.tools/sdk/platforms/android-36/android.jar')) {
        throw 'Run build.ps1 -Setup once to download the pinned Android SDK and accept its SDK licenses.'
    }

    if (-not (Test-Path 'keys/research.jks')) {
        $random = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($random); $rng.Dispose()
        $env:ROI_KEY_PASSWORD = -join ($random | ForEach-Object { $_.ToString('x2') })
        & "$env:JAVA_HOME/bin/keytool.exe" -genkeypair -keystore keys/research.jks -alias roi -keyalg RSA -keysize 3072 -validity 10000 -storetype PKCS12 -storepass:env ROI_KEY_PASSWORD -keypass:env ROI_KEY_PASSWORD -dname 'CN=ROI Research Viewer'
        if ($LASTEXITCODE -ne 0) { throw 'APK signing key generation failed.' }
        Set-Content -LiteralPath 'keys/signing.properties' -Value "password=$env:ROI_KEY_PASSWORD" -Encoding ASCII
        $env:ROI_KEY_PASSWORD = $null
    }
    if (-not (Test-Path 'keys/signing.properties')) { throw 'Restore keys/signing.properties for the existing signing key.' }
    & "$env:JAVA_HOME/bin/javac.exe" --release 17 -encoding UTF-8 -d .tools/check app/src/main/java/kr/ac/roi/viewer/ConnectionPolicy.java checks/ConnectionCheck.java
    if ($LASTEXITCODE -ne 0) { throw 'Connection policy check compilation failed.' }
    & "$env:JAVA_HOME/bin/java.exe" -cp .tools/check ConnectionCheck
    if ($LASTEXITCODE -ne 0) { throw 'Connection policy check failed.' }
    & .\gradlew.bat assembleRelease lintRelease --no-daemon --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed.' }
    & '.tools/sdk/build-tools/36.0.0/apksigner.bat' verify --verbose app/build/outputs/apk/release/app-release.apk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    Copy-Item -LiteralPath 'app/build/outputs/apk/release/app-release.apk' -Destination 'dist/ROIViewer.apk' -Force
    $hash = (Get-FileHash -LiteralPath 'dist/ROIViewer.apk' -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath 'dist/ROIViewer.apk.sha256' -Value "$hash  ROIViewer.apk" -Encoding ASCII
    Write-Output "APK: $PSScriptRoot/dist/ROIViewer.apk"
} finally {
    $env:ROI_KEY_PASSWORD = $null
    Pop-Location
}
