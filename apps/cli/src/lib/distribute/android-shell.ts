import type { NativeConfig, Orientation } from "./config.js";

/**
 * The edits that turn Capacitor's stock Android project into this game's, as
 * text transforms over the files that hold them. They run on every
 * `vg distribute android`, so each one replaces what it finds rather than
 * adding to it.
 */

const MANAGED_START = "<!-- vg:distribute -->";
const MANAGED_END = "<!-- /vg:distribute -->";

const ORIENTATION_ATTRIBUTE: Record<Orientation, string | null> = {
  any: null,
  landscape: "sensorLandscape",
  portrait: "sensorPortrait",
};

const manifestPermissions = (config: NativeConfig): string[] => {
  const lines: string[] = [];
  // `required="false"` on each feature: a permission implies its hardware, and
  // Play hides the game from every device without it unless told otherwise.
  if (config.permissions.camera !== undefined) {
    lines.push(
      '<uses-permission android:name="android.permission.CAMERA" />',
      '<uses-feature android:name="android.hardware.camera" android:required="false" />',
    );
  }
  if (config.permissions.microphone !== undefined) {
    lines.push(
      '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
      '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
      '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
    );
  }
  return lines;
};

export const setManifest = (manifest: string, config: NativeConfig): string => {
  const managed = new RegExp(`\\s*${MANAGED_START}[\\s\\S]*?${MANAGED_END}`, "u");
  let next = manifest.replace(managed, "").replace(/\s*android:screenOrientation="[^"]*"/u, "");

  const orientation = ORIENTATION_ATTRIBUTE[config.orientation];
  if (orientation !== null) {
    next = next.replace(
      'android:name=".MainActivity"',
      `android:name=".MainActivity"\n            android:screenOrientation="${orientation}"`,
    );
  }

  const permissions = manifestPermissions(config);
  if (permissions.length === 0) {
    return next;
  }
  const end = next.lastIndexOf("</manifest>");
  if (end === -1) {
    throw new Error("AndroidManifest.xml has no closing </manifest>.");
  }
  const block = [MANAGED_START, ...permissions, MANAGED_END].map((line) => `    ${line}`);
  return `${next.slice(0, end).trimEnd()}\n${block.join("\n")}\n${next.slice(end)}`;
};

/** The applicationId the Android project was created with. */
export const readApplicationId = (buildGradle: string): string | null =>
  /applicationId\s+"(?<id>[^"]+)"/u.exec(buildGradle)?.groups?.id ?? null;

export const setGradleVersion = (buildGradle: string, config: NativeConfig): string =>
  buildGradle
    .replace(/versionCode\s+\d+/u, `versionCode ${config.build}`)
    .replace(/versionName\s+"[^"]*"/u, `versionName "${config.version}"`);

/**
 * The activity, with the system bars hidden: a game is drawn edge to edge, and
 * a swipe from the edge still brings the bars back for a moment.
 */
export const mainActivitySource = (appId: string): string => `package ${appId};

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) {
            return;
        }
        WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
        bars.hide(WindowInsetsCompat.Type.systemBars());
    }
}
`;
