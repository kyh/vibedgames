import type { NativeConfig, Orientation } from "./config.js";

/**
 * The edits that turn Capacitor's stock iOS project into this game's, as text
 * transforms over the two files that hold them. They run on every
 * `vg distribute ios`, so each one replaces what it finds rather than adding to it.
 */

type PlistValue = string | boolean | string[];

/** Top-level Info.plist keys and what each is set to. */
export interface PlistEntries {
  [key: string]: PlistValue;
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const renderValue = (value: PlistValue) => {
  if (value === true) {
    return "<true/>";
  }

  if (value === false) {
    return "<false/>";
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => `\t\t<string>${escapeXml(item)}</string>`).join("\n");

    return `<array>\n${items}\n\t</array>`;
  }

  return `<string>${escapeXml(value)}</string>`;
};

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Set top-level Info.plist keys, replacing any that are already there. */
export const setPlistEntries = (plist: string, entries: PlistEntries) => {
  let next = plist;

  for (const key of Object.keys(entries)) {
    const existing = new RegExp(
      `\\s*<key>${escapeRegExp(key)}</key>\\s*(?:<string>[^<]*</string>|<true/>|<false/>|<array>[\\s\\S]*?</array>)`,
      "u",
    );

    next = next.replace(existing, "");
  }

  const end = next.lastIndexOf("</dict>");

  if (end === -1) {
    throw new Error("Info.plist has no closing </dict>: not a property list this can edit.");
  }

  const added = Object.entries(entries)
    .map(([key, value]) => `\t<key>${key}</key>\n\t${renderValue(value)}\n`)
    .join("");

  return `${next.slice(0, end).trimEnd()}\n${added}${next.slice(end)}`;
};

const PORTRAIT = ["UIInterfaceOrientationPortrait"];
const LANDSCAPE = ["UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"];

const ORIENTATION_MASKS: Record<Orientation, string[]> = {
  any: [...PORTRAIT, ...LANDSCAPE],
  landscape: LANDSCAPE,
  portrait: PORTRAIT,
};

export const iosPlistEntries = (config: NativeConfig) => {
  const entries: PlistEntries = {
    ITSAppUsesNonExemptEncryption: false,
    UIRequiresFullScreen: true,
    UIStatusBarHidden: true,
    UISupportedInterfaceOrientations: ORIENTATION_MASKS[config.orientation],
    "UISupportedInterfaceOrientations~ipad": ORIENTATION_MASKS[config.orientation],
    UIViewControllerBasedStatusBarAppearance: false,
  };

  if (config.permissions.camera !== undefined) {
    entries.NSCameraUsageDescription = config.permissions.camera;
  }

  if (config.permissions.microphone !== undefined) {
    entries.NSMicrophoneUsageDescription = config.permissions.microphone;
  }

  return entries;
};

/** Point every build configuration at this game's identity and version. */
export const setXcodeBuildSettings = (pbxproj: string, config: NativeConfig) =>
  pbxproj
    .replaceAll(/MARKETING_VERSION = [^;]+;/gu, `MARKETING_VERSION = ${config.version};`)
    .replaceAll(/CURRENT_PROJECT_VERSION = [^;]+;/gu, `CURRENT_PROJECT_VERSION = ${config.build};`)
    .replaceAll(
      /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/gu,
      `PRODUCT_BUNDLE_IDENTIFIER = ${config.appId};`,
    );
