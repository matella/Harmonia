#!/usr/bin/env node
// Runs the Android Gradle wrapper with a usable JDK. Uses JAVA_HOME when set;
// otherwise falls back to Android Studio's bundled JBR. Gradle's Foojay resolver
// then provisions the JDK 21 toolchain required by Capacitor plugins.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const androidDir = resolve(import.meta.dirname, '..', 'android');
const env = { ...process.env };

if (!env.JAVA_HOME) {
  const candidates =
    platform() === 'win32'
      ? [join(env.LOCALAPPDATA ?? '', 'Programs', 'Android Studio', 'jbr'), 'C:\Program Files\Android\Android Studio\jbr']
      : platform() === 'darwin'
        ? ['/Applications/Android Studio.app/Contents/jbr/Contents/Home']
        : [join(homedir(), 'android-studio', 'jbr'), '/opt/android-studio/jbr'];
  const found = candidates.find((dir) => existsSync(join(dir, 'bin')));
  if (found) env.JAVA_HOME = found;
}
if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
  const sdk =
    platform() === 'win32'
      ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
      : platform() === 'darwin'
        ? join(homedir(), 'Library', 'Android', 'sdk')
        : join(homedir(), 'Android', 'Sdk');
  if (existsSync(sdk)) env.ANDROID_HOME = sdk;
}

const wrapper = platform() === 'win32' ? `"${join(androidDir, 'gradlew.bat')}"` : './gradlew';
const result = spawnSync(wrapper, [...process.argv.slice(2), '--console=plain'], {
  cwd: androidDir,
  env,
  stdio: 'inherit',
  shell: platform() === 'win32',
});
process.exit(result.status ?? 1);
