// Before `electron-vite dev` launches: make the Electron binary in
// node_modules look like Deep Review. The Dock, Cmd-Tab and the menu bar
// take their icon and name from the app bundle, not from JavaScript, so
// the only way the development app shows our icon from the first frame —
// instead of Electron's logo until app.whenReady — and says "Deep Review"
// in the menu bar is to write them into the bundle. Idempotent; the
// packaged app gets these from electron-builder and never runs this.
import { createRequire } from "node:module";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve("electron/package.json"));
const app = path.join(electronDir, "dist", "Electron.app");
if (!existsSync(app)) {
  console.warn("dev-identity: no Electron.app in node_modules; skipping");
  process.exit(0);
}

const icns = path.join(here, "..", "build", "icon.icns");
copyFileSync(icns, path.join(app, "Contents", "Resources", "electron.icns"));

const plistFile = path.join(app, "Contents", "Info.plist");
const plist = readFileSync(plistFile, "utf8");
const renamed = plist
  .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/, "$1Deep Review$2")
  .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, "$1Deep Review$2");
if (renamed !== plist) writeFileSync(plistFile, renamed);
console.log("dev-identity: Electron.app carries the Deep Review icon and name");
