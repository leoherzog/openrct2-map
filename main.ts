// CLI that renders an OpenRCT2 save into a Leaflet tile viewer: OpenRCT2 screenshots each rotation, sharp tiles
// the screenshots, and each run appends a deduplicated snapshot to the output directory's timeline.
// It also lists, renames and removes snapshots.
import { parseArgs, promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

const execFile = promisify(execFileCb);

function makeTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// OpenRCT2 binary and game data
// ---------------------------------------------------------------------------

/**
 * Returns the newest OpenRCT2 AppImage or exe in cwd, else a well-known install path, else a Windows portable dir
 * in cwd. Otherwise returns the bare name `openrct2`, which main treats as nothing found.
 */
function findOpenRCT2(): string {
  const newestFirst = (a: string, b: string) => b.localeCompare(a, "en", { numeric: true });
  const entries = fs.readdirSync(process.cwd());
  const binaries = entries
    .filter((e) => /^OpenRCT2-.*\.(AppImage|exe)$/i.test(e))
    .sort(newestFirst);
  if (binaries.length > 0) {
    return path.resolve(binaries[0]);
  }

  const knownPaths: string[] = [];
  if (process.platform === "win32") {
    knownPaths.push("C:\\Program Files\\OpenRCT2\\openrct2.exe");
  } else if (process.platform === "darwin") {
    knownPaths.push("/Applications/OpenRCT2.app/Contents/MacOS/OpenRCT2");
  } else if (process.platform === "linux") {
    knownPaths.push("/usr/bin/openrct2", "/usr/local/bin/openrct2");
  }
  const found = knownPaths.find(p => fs.existsSync(p));
  if (found) return found;

  if (process.platform === "win32") {
    for (const e of entries.filter(e => /^OpenRCT2-.*-windows-portable/.test(e)).sort(newestFirst)) {
      const exe = path.resolve(e, "openrct2.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }

  return "openrct2";
}

/** Streams url to dest through dest.tmp, so dest exists only once complete. */
async function download(url: string, dest: string, mode?: number): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  try {
    await pipeline(res.body, fs.createWriteStream(`${dest}.tmp`, { mode }));
    fs.renameSync(`${dest}.tmp`, dest);
  } catch (err) {
    fs.rmSync(`${dest}.tmp`, { force: true });
    throw err;
  }
}

async function downloadPortableOpenRCT2(): Promise<string | undefined> {
  // Releases ship a Linux AppImage for x86_64 only, and no portable macOS build.
  let assetPattern: RegExp;
  if (process.platform === "linux" && process.arch === "x64") {
    assetPattern = /^OpenRCT2-.*-linux-x86_64\.AppImage$/;
  } else if (process.platform === "win32") {
    assetPattern = process.arch === "arm64"
      ? /^OpenRCT2-.*-windows-portable-arm64\.zip$/
      : /^OpenRCT2-.*-windows-portable-x64\.zip$/;
  } else {
    return undefined;
  }

  console.error("Checking for latest OpenRCT2 release...");
  const resp = await fetch("https://api.github.com/repos/OpenRCT2/OpenRCT2/releases/latest", {
    headers: { "User-Agent": "openrct2-map" },
  });
  if (!resp.ok) {
    console.error(`Warning: Could not check OpenRCT2 releases (HTTP ${resp.status}).`);
    return undefined;
  }
  const release: any = await resp.json();

  const asset = release.assets?.find((a: any) => assetPattern.test(a.name));
  if (!asset) {
    console.error(`Warning: No portable OpenRCT2 found for ${process.platform}/${process.arch}.`);
    return undefined;
  }
  // asset.name becomes a path under cwd; reject separators and '..'.
  if (/[/\\]|\.\./.test(asset.name)) {
    console.error(`Warning: Suspicious asset name '${asset.name}', skipping auto-download.`);
    return undefined;
  }

  const sizeMB = (asset.size / 1048576).toFixed(1);
  if (process.platform === "linux") {
    const targetPath = path.join(process.cwd(), asset.name);
    if (fs.existsSync(targetPath)) {
      console.error(`OpenRCT2 ${release.tag_name} already downloaded.`);
      return targetPath;
    }
    console.error(`Downloading ${asset.name} (${sizeMB} MB)...`);
    await download(asset.browser_download_url, targetPath, 0o755);
    console.error(`Downloaded ${asset.name}`);
    return targetPath;
  }

  // Windows: the portable zip holds openrct2.exe at its root.
  const zipPath = path.join(process.cwd(), asset.name);
  const extractDir = zipPath.replace(/\.zip$/, "");
  const exePath = path.join(extractDir, "openrct2.exe");
  if (fs.existsSync(exePath)) {
    console.error(`OpenRCT2 ${release.tag_name} already downloaded.`);
    return exePath;
  }
  console.error(`Downloading ${asset.name} (${sizeMB} MB)...`);
  try {
    await download(asset.browser_download_url, zipPath);
    // PowerShell single-quoted literals escape ' as ''.
    const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
    await execFile("powershell", [
      "-NoProfile", "-Command",
      `Expand-Archive -Force -Path ${ps(zipPath)} -DestinationPath ${ps(extractDir)}`,
    ]);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
  console.error(`Downloaded and extracted ${asset.name}`);
  return exePath;
}

/** Downloads the RCT2 game data archive from archive.org and extracts it to ./assets/RCT. */
async function downloadGameAssets(): Promise<void> {
  const assetsDir = path.join(process.cwd(), "assets");
  // Every archive entry sits under RCT/. Staging the zip in assets/RCT keeps it off tmpfs and out of git.
  const zipPath = path.join(assetsDir, "RCT", "RCT.zip");
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  console.error("Downloading RCT2 game assets from archive.org...");
  try {
    await download("https://archive.org/download/OpenRCT2Assets/RCT.zip", zipPath);
    // Discovery checks Data/g1.dat, so extract it last; an interrupted extraction then re-downloads.
    await execFile("unzip", ["-o", "-q", zipPath, "-x", "RCT/Data/g1.dat", "-d", assetsDir]);
    await execFile("unzip", ["-o", "-q", zipPath, "RCT/Data/g1.dat", "-d", assetsDir]);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
  console.error("Downloaded game assets to assets/RCT/");
}

/**
 * Finds the first dir holding one of `files`: ./assets/RCT, then the path under `configKey` in the
 * user's own OpenRCT2 config.ini, which the temporary XDG_CONFIG_HOME hides from OpenRCT2, then Steam.
 */
function findGameData(files: string[], configKey: string, steamNames: string[]): string | undefined {
  const home = os.homedir();
  const candidates = [path.join(process.cwd(), "assets", "RCT")];
  try {
    const ini = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "OpenRCT2", "config.ini"), "utf8");
    const configured = new RegExp(`^${configKey} = "(.*)"`, "m").exec(ini)?.[1];
    if (configured) candidates.push(configured);
  } catch {}
  for (const steam of [".local/share/Steam", "snap/steam/common/.local/share/Steam"]) {
    for (const name of steamNames) candidates.push(path.join(home, steam, "steamapps", "common", name));
  }
  return candidates.find((dir) => files.some((f) => fs.existsSync(path.join(dir, f))));
}

function findRCT2Data(): string | undefined {
  // RCT Classic keeps g1.dat under Assets/.
  return findGameData(["Data/g1.dat", "Assets/g1.dat"], "game_path", ["Rollercoaster Tycoon 2", "RollerCoaster Tycoon Classic"]);
}

function findRCT1Data(): string | undefined {
  // Steam's RCT1 ships Data/CSG1.DAT in upper case.
  return findGameData(["Data/csg1.dat", "Data/CSG1.DAT"], "rct1_path", ["RollerCoaster Tycoon Deluxe"]);
}

/** Returns the flag lines of the screenshot section of `bin -ha`, or null on any failure. */
async function getScreenshotFlags(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(bin, ["-ha"], { timeout: 10_000 });
    const lines = stdout.split("\n");

    // -ha prints each subcommand's name between dash lines, followed by its indented --flag lines.
    let sectionStart = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^screenshot\s*$/.test(lines[i]) && /^-{3,}\s*$/.test(lines[i - 1])) {
        sectionStart = i;
        break;
      }
    }
    if (sectionStart === -1) return null;

    let contentStart = sectionStart + 1;
    if (/^-{3,}\s*$/.test(lines[contentStart] ?? "")) contentStart++;

    const flagLines: string[] = [];
    for (let i = contentStart; i < lines.length; i++) {
      const line = lines[i];
      if (/^-{3,}\s*$/.test(line)) break;
      if (/^\s+--/.test(line)) {
        flagLines.push(line);
      }
    }
    if (flagLines.length === 0) return null;
    return flagLines.join("\n");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot storage
// ---------------------------------------------------------------------------

interface TimePoint {
  timestamp: string;
  label: string;
  hash?: string;     // SHA-256 over this snapshot's giant PNGs
  saveHash?: string; // SHA-256 of the input save file
  // Absent in timelines written by v1.0.0; readers fall back to the manifest-level values.
  maxZoom?: number;
  imageWidth?: number;
  imageHeight?: number;
}

interface TimelineManifest {
  timePoints: TimePoint[];
  rotations: number[];
  // Maxima across timepoints. The viewer uses them as the map's maxZoom and for timepoints without their own.
  maxZoom: number;
  imageWidth: number;
  imageHeight: number;
  tileSize: number;
}

function readManifest(dir: string): TimelineManifest | null {
  const p = path.join(dir, "timeline.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err: any) {
    throw new Error(`${p}: ${err.message}`);
  }
}

function requireManifest(dir: string): TimelineManifest {
  const manifest = readManifest(dir);
  if (!manifest) {
    console.error("Error: No timeline.json found in output directory.");
    process.exit(1);
  }
  return manifest;
}

/** Replaces timeline.json via a temp file, so a crash never leaves it truncated. */
function writeManifest(dir: string, manifest: TimelineManifest): void {
  const p = path.join(dir, "timeline.json");
  fs.writeFileSync(p + ".tmp", JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(p + ".tmp", p);
}

/** Fills each snapshot's missing extents from the manifest, then sets the manifest extents to their max. */
function updateExtents(m: TimelineManifest): void {
  for (const tp of m.timePoints) {
    tp.maxZoom ??= m.maxZoom;
    tp.imageWidth ??= m.imageWidth;
    tp.imageHeight ??= m.imageHeight;
  }
  m.maxZoom = Math.max(...m.timePoints.map(tp => tp.maxZoom!));
  m.imageWidth = Math.max(...m.timePoints.map(tp => tp.imageWidth!));
  m.imageHeight = Math.max(...m.timePoints.map(tp => tp.imageHeight!));
}

function deduplicateSnapshot(newSnapshotDir: string, prevSnapshotDir: string): { total: number; deduped: number } {
  let total = 0;
  let deduped = 0;

  function walkDir(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".png")) {
        total++;
        const relPath = path.relative(newSnapshotDir, fullPath);
        const prevPath = path.join(prevSnapshotDir, relPath);

        if (!fs.existsSync(prevPath)) continue;

        // Target the real file so links never chain; removal materializes only links whose realpath is inside the removed snapshot.
        const prevReal = fs.realpathSync(prevPath);
        const newContent = fs.readFileSync(fullPath);
        const prevContent = fs.readFileSync(prevReal);

        if (newContent.equals(prevContent)) {
          // A relative target keeps the output dir relocatable.
          const relTarget = path.relative(path.dirname(fullPath), prevReal);
          // Rename a temp link over the tile, so where symlinks fail, as on Windows without admin or Developer Mode, the real file stays.
          const tmp = fullPath + ".tmp";
          try { fs.symlinkSync(relTarget, tmp); } catch { continue; }
          fs.renameSync(tmp, fullPath);
          deduped++;
        }
      }
    }
  }

  walkDir(newSnapshotDir);
  return { total, deduped };
}

/** Deletes snapshots/<name>, first replacing symlinks in other snapshots that resolve into it with copies. */
function deleteSnapshotDir(snapshotsDir: string, name: string): void {
  const doomed = fs.realpathSync(path.join(snapshotsDir, name));
  for (const other of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
    if (other.name === name || !other.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(snapshotsDir, other.name), { recursive: true, withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const link = path.join(entry.parentPath, entry.name);
      let real: string;
      try { real = fs.realpathSync(link); } catch { continue; } // a dangling link has nothing to copy
      if (real.startsWith(doomed + path.sep)) {
        fs.unlinkSync(link);
        fs.copyFileSync(real, link);
      }
    }
  }
  fs.rmSync(path.join(snapshotsDir, name), { recursive: true, force: true });
}

function removeSnapshot(outputDir: string, timestamp: string, domain?: string, status?: string): void {
  const manifest = requireManifest(outputDir);

  if (manifest.timePoints.length <= 1) {
    console.error("Error: Cannot remove the last snapshot.");
    process.exit(1);
  }

  const idx = manifest.timePoints.findIndex(tp => tp.timestamp === timestamp);
  if (idx === -1) {
    console.error(`Error: Snapshot '${timestamp}' not found in timeline.`);
    console.error(`Available: ${manifest.timePoints.map(tp => tp.timestamp).join(", ")}`);
    process.exit(1);
  }

  // The manifest goes first, so an interrupted removal leaves an orphan for the next render's cleanup.
  manifest.timePoints.splice(idx, 1);
  updateExtents(manifest);
  writeManifest(outputDir, manifest);
  fs.writeFileSync(path.join(outputDir, "index.html"), generateHtml(manifest, domain, status));

  const snapshotsDir = path.join(outputDir, "snapshots");
  if (fs.existsSync(path.join(snapshotsDir, timestamp))) deleteSnapshotDir(snapshotsDir, timestamp);

  console.error(`Removed snapshot '${timestamp}'. ${manifest.timePoints.length} snapshot(s) remain.`);
}

/** Deletes leftovers of interrupted renders. A render in progress has the same artifacts, so call this only at the start of a render. */
function cleanupStaleArtifacts(outputDir: string): void {
  if (!fs.existsSync(outputDir)) return;

  for (const entry of fs.readdirSync(outputDir)) {
    if (/^giant_r\d+_z\d+\.png$/.test(entry)) {
      fs.unlinkSync(path.join(outputDir, entry));
      console.error(`Cleaned up stale screenshot: ${entry}`);
    }
  }

  const snapshotsDir = path.join(outputDir, "snapshots");
  if (!fs.existsSync(snapshotsDir)) return;

  // Scratch dirs of assembleNativeTiles.
  for (const snapshotName of fs.readdirSync(snapshotsDir)) {
    const snapshotPath = path.join(snapshotsDir, snapshotName);
    if (!fs.statSync(snapshotPath).isDirectory()) continue;
    for (const entry of fs.readdirSync(snapshotPath)) {
      if (entry.startsWith(".tmp-nz-")) {
        fs.rmSync(path.join(snapshotPath, entry), { recursive: true, force: true });
        console.error(`Cleaned up stale temp dir: snapshots/${snapshotName}/${entry}`);
      }
    }
  }

  const manifest = readManifest(outputDir);
  if (!manifest) return; // every snapshot would look orphaned
  const knownTimestamps = new Set(manifest.timePoints.map(tp => tp.timestamp));
  for (const dir of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
    if (!dir.isDirectory() || knownTimestamps.has(dir.name)) continue;
    deleteSnapshotDir(snapshotsDir, dir.name);
    console.error(`Cleaned up orphaned snapshot: ${dir.name}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o", default: "./output" },
        zoom: { type: "string", default: "1" },
        rotations: { type: "string", default: "0,1,2,3" },
        openrct2: { type: "string" },
        "rct1-data-path": { type: "string" },
        "rct2-data-path": { type: "string" },
        label: { type: "string" },
        list: { type: "boolean", default: false },
        rename: { type: "string" },
        remove: { type: "string" },
        clear: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "tile-size": { type: "string", default: "256" },
        compression: { type: "string", default: "6" },
        effort: { type: "string" },
        palette: { type: "boolean", default: false },
        "skip-blanks": { type: "string", default: "0" },
        concurrency: { type: "string" },
        "single-zoom": { type: "boolean", default: false },
        domain: { type: "string" },
        status: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err: any) {
    console.error(`Error: ${err.message}`); process.exit(1);
  }
})();

let outputDir = path.resolve(values.output);
const listSnapshots = values.list;
const renameTimestamp = values.rename;
const removeTimestamp = values.remove;
const clearSnapshots = values.clear;
const forceSnapshot = values.force;
const singleZoom = values["single-zoom"];
function requireInt(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n)) { console.error(`Error: --${name} must be a number, got '${value}'`); process.exit(1); }
  return n;
}

const tileSize = requireInt(values["tile-size"], "tile-size");
const compressionLevel = requireInt(values.compression, "compression");
const pngEffort = values.effort !== undefined ? requireInt(values.effort, "effort") : undefined;
// sharp treats a PNG effort as palette quantization effort, so --effort implies --palette.
const usePalette = values.palette || pngEffort !== undefined;
const skipBlanks = requireInt(values["skip-blanks"], "skip-blanks");
const domain = values.domain;
if (values.status?.trim() === "") {
  console.error("Error: --status requires a server name."); process.exit(1);
}
const statusName = values.status;
if (values.concurrency !== undefined) {
  sharp.concurrency(requireInt(values.concurrency, "concurrency"));
}

if (values.help || (positionals.length === 0 && !listSnapshots && !renameTimestamp && !removeTimestamp)) {
  let helpText = `Usage: node main.ts <savefile> [options] [-- openrct2-flags...]

Options:
  -o, --output <dir>       Output directory (default: ./output)
  --zoom <n>               Finest OpenRCT2 zoom level, 0 = closest (default: 1)
                           Renders at zoom n through 3 for native sprites at each level
  --rotations <list>       Comma-separated rotations 0-3 to render (default: 0,1,2,3)
  --openrct2 <path>        Path to openrct2 binary/AppImage (default: auto-detect)
  --rct2-data-path <path>  Path to RCT2 data dir (containing Data/g1.dat) [Linux only, auto-detected]
  --rct1-data-path <path>  Path to RCT1 data dir (containing Data/csg1.dat) [Linux only, auto-detected]
  --label <text>           Label for this snapshot (default: current date/time)
  --list                   List all snapshots in the output directory
  --rename <timestamp>     Rename a snapshot label (use with --label)
  --remove <timestamp>     Remove a snapshot by its timestamp key
  --clear                  Clear all existing snapshots before generating
  --force                  Save snapshot even if map is unchanged from last run
  --tile-size <n>          Tile size in pixels (default: 256)
  --compression <0-9>      PNG compression level (default: 6, 0 = fastest)
  --effort <1-10>          Palette quantization effort (default: 7, implies --palette)
                           Below 4 is faster but lossy
  --palette                Use indexed-color PNG (smaller files for pixel art)
  --skip-blanks <n>        Skip tiles within n of transparent (default: 0)
                           Use --skip-blanks=-1 to keep every tile
  --concurrency <n>        Sharp/libvips thread count (default: CPU cores)
  --single-zoom            Only render at the specified zoom level (skip native zoom pyramid)
  --domain <url>           Base URL for OG tags (e.g. https://example.com/map)
  --status <name>          Show live online/offline status of this advertised server
  -h, --help               Show this help

Auto-download: without --openrct2, a render that finds no OpenRCT2, or finds a
  portable copy in the current directory, downloads the latest release there if
  missing (Linux x86_64, Windows). An install in a standard path is never replaced.
  On Linux, RCT2 assets are downloaded to ./assets/RCT unless found or
  --rct2-data-path is set. Elsewhere OpenRCT2 uses game_path from its own config.ini.

Screenshot defaults (applied unless you override that specific flag after --):
  --transparent, --tidy-up-park, --weather=1

Extra flags after -- are forwarded to openrct2 screenshot, e.g.:
  node main.ts park.park -o out -- --no-peeps
  node main.ts park.park -o out -- --weather=3  (overrides default sunny)`;

  const openrct2Bin = values.openrct2 ?? findOpenRCT2();
  console.error(`Using OpenRCT2: ${openrct2Bin}`);
  const screenshotFlags = await getScreenshotFlags(openrct2Bin);
  if (screenshotFlags) {
    helpText += `\n\nOpenRCT2 screenshot flags (pass after --):\n${screenshotFlags}`;
  }

  console.log(helpText);
  process.exit(0);
}

if (!/^[0-3](,[0-3])*$/.test(values.rotations)) {
  console.error(`Error: --rotations must be comma-separated values from 0 to 3, got '${values.rotations}'`); process.exit(1);
}
const rotations = [...new Set(values.rotations.split(",").map(Number))];
const snapshotLabel = values.label ?? new Date().toLocaleString();

// Generation-run inputs; --list, --rename and --remove skip this block.
let inputFile = "";
let extraFlags: string[] = [];
let ozRange: number[] = [];

if (!listSnapshots && !renameTimestamp && !removeTimestamp) {
  inputFile = path.resolve(positionals[0]);
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: input file not found: ${inputFile}`);
    process.exit(1);
  }
  const zoomLevel = requireInt(values.zoom, "zoom");
  if (zoomLevel < 0 || zoomLevel > 3) {
    console.error("Error: --zoom must be between 0 and 3."); process.exit(1);
  }
  ozRange = singleZoom
    ? [zoomLevel]
    : Array.from({ length: 3 - zoomLevel + 1 }, (_, i) => zoomLevel + i);

  // Each default applies unless the user sets that flag. Any flag that --tidy-up-park bundles also drops it,
  // so a user can pick a subset of the tidy-up.
  const userFlags = positionals.slice(1);
  const hasFlag = (f: string) => userFlags.some((u) => u === f || u.startsWith(f + "="));
  const defaults: string[] = [];
  if (!hasFlag("--transparent")) defaults.push("--transparent");
  if (!hasFlag("--weather")) defaults.push("--weather=1");
  const tidyFlags = ["--tidy-up-park", "--clear-grass", "--water-plants", "--fix-vandalism", "--remove-litter"];
  if (!tidyFlags.some((f) => hasFlag(f))) defaults.push("--tidy-up-park");
  extraFlags = [...defaults, ...userFlags];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let screenshotCounter = 0;

/** Writes one giant screenshot to outputDir and returns its path; throws if openrct2 fails. */
async function generateScreenshot(
  rotation: number,
  zoom: number,
  openrct2Bin: string,
  configDir: string,
): Promise<string> {
  const outPng = path.join(outputDir, `giant_r${rotation}_z${zoom}.png`);
  const args = [
    "screenshot",
    inputFile,
    outPng,
    "giant",
    String(zoom),
    // Tool rotation N is OpenRCT2 rotation N+1; changing the offset misorients new snapshots against existing ones.
    String((rotation + 1) % 4),
    ...extraFlags,
  ];

  const total = rotations.length * ozRange.length;
  console.error(`[${++screenshotCounter}/${total}] openrct2 ${args.join(" ")}`);

  try {
    await execFile(openrct2Bin, args, { timeout: 600_000, env: { ...process.env, XDG_CONFIG_HOME: configDir } });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`'${openrct2Bin}' not found. Install OpenRCT2 or use --openrct2 <path>.`);
    }
    const stderr = (err.stderr ?? "").trim();
    const exitInfo = typeof err.code === "number" ? `exit code ${err.code}`
      : err.code ? String(err.code)
      : err.killed ? "timed out after 10 minutes"
      : err.signal ? `killed by ${err.signal}` : "unknown error";
    throw new Error(`openrct2 screenshot failed (${exitInfo}).${stderr ? `\n${stderr}` : ""}`);
  }

  return outPng;
}

interface TileMetadata {
  rotation: number;
  width: number;
  height: number;
  maxZoom: number;
}

async function generateTiles(
  giantPng: string,
  rotation: number,
  targetBaseDir: string,
): Promise<TileMetadata> {
  const meta = await sharp(giantPng, { limitInputPixels: false }).metadata();
  const width = meta.width!;
  const height = meta.height!;

  const tileDir = path.join(targetBaseDir, String(rotation));

  console.error(
    `  Tiling rotation ${rotation}: ${width}x${height}px -> ${tileDir}`,
  );

  await sharp(giantPng, { limitInputPixels: false })
    .png({ compressionLevel })
    .tile({
      size: tileSize,
      layout: "google",
      overlap: 0,
      skipBlanks: skipBlanks,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toFile(tileDir);

  const zoomDirs = fs.readdirSync(tileDir)
    .filter((d) => /^\d+$/.test(d))
    .map(Number);
  const maxZoom = Math.max(...zoomDirs);

  return { rotation, width, height, maxZoom };
}

/**
 * Builds one rotation's pyramid from renders at several OpenRCT2 zoom levels (OZ).
 * Each OZ step halves the image, so consecutive renders' sharp maxZoom differ by one and
 * their tile grids align; each finer render replaces its level's downscaled tiles.
 */
async function assembleNativeTiles(
  pngsForRotation: { zoom: number; path: string }[],
  rotation: number,
  targetBaseDir: string,
): Promise<TileMetadata> {
  // A higher OZ is more zoomed out, so the coarsest render comes first.
  const sorted = [...pngsForRotation].sort((a, b) => b.zoom - a.zoom);

  if (sorted.length === 1) {
    return generateTiles(sorted[0].path, rotation, targetBaseDir);
  }

  const baseMeta = await generateTiles(sorted[0].path, rotation, targetBaseDir);
  console.error(`    Base pyramid from OZ${sorted[0].zoom}: z=0-${baseMeta.maxZoom}`);

  let finestMeta = baseMeta;
  for (let i = 1; i < sorted.length; i++) {
    const tempDir = fs.mkdtempSync(path.join(targetBaseDir, ".tmp-nz-"));
    try {
      const ozMeta = await generateTiles(sorted[i].path, rotation, tempDir);
      const nativeZ = ozMeta.maxZoom;

      const srcDir = path.join(tempDir, String(rotation), String(nativeZ));
      const dstDir = path.join(targetBaseDir, String(rotation), String(nativeZ));

      if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true });
      fs.renameSync(srcDir, dstDir);

      console.error(`    Native OZ${sorted[i].zoom} tiles at z=${nativeZ}`);
      finestMeta = ozMeta;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // The finest render's size and maxZoom define the viewer's coordinate space.
  return { rotation, width: finestMeta.width, height: finestMeta.height, maxZoom: finestMeta.maxZoom };
}

// sharp's tile() forwards only the compression level, so indexed color needs a second pass over the written tiles.
async function palettizeTiles(dir: string): Promise<void> {
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".png"));
  const worker = async () => {
    for (let f = files.pop(); f !== undefined; f = files.pop()) {
      const file = path.join(dir, f);
      const png = await sharp(fs.readFileSync(file)).png({ compressionLevel, palette: true, effort: pngEffort }).toBuffer();
      fs.writeFileSync(file, png);
    }
  };
  await Promise.all(Array.from({ length: os.availableParallelism() }, worker));
}

// ---------------------------------------------------------------------------
// HTML viewer
// ---------------------------------------------------------------------------

// Base64 of the same-named files in assets/; FONT_RCT2 is rct2.otf.woff2. Re-encode after editing a source file.
// FAVICON is a hand-minified assets/roller-coaster-sharp-duotone-light-full.svg.
const ICON_ROTATE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAACdQTFRFAAAAFyMj/3tz/6uj/9vX/09D/wcA4wcAxwAAqwAAjwAAcwAA//PfHRUh3gAAAAF0Uk5TAEDm2GYAAADxSURBVHjazdNRTsMwEEXR+5y2CbD/nVKS0IwfGGFNqzZC/CDy59yjiRXZ4odHfwty6T0gCQEB3gGDhLfSjB+Bo+Tm6qUQfgBOwgjEJwnfgxGwAEGN8C4QwjW2ayCMxlxJLq8k0Lj6ZoLYjgnQeKn5xQkoLnOAeg+HoXN4osyHFdR7PJ8xCV6Yj5pBvVOmJToYpsU+lPIGovW6AUIwsUwL2Byk4dwnTOEApK8ImEE3oHpDpglbRm5gdW7SNUCWDE2QoI/wt6gy2fM/VHA0YbInaCOAZhigZQwJ0OkdRhug1bsj17aPYP/Q6votvwH/4G5+AEtIfyHh01/DAAAAAElFTkSuQmCC';
const ICON_ZOOM_IN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAEJQTFRFAAAAFyMj//uP//Nf///DP1NTW3Nzb4OD/+cvg5eXt8PD7/Pz88sbn6+v16cTv4sPp28Hj1MHXysAIzMzS2NjL0NDdDvM6gAAAAF0Uk5TAEDm2GYAAAD6SURBVHjazdJdT4MwGIbh5255yzq+hrD//wM90hg3HFDjTBYDOE882MVJE+6+TZPqAbBcp18Drp/mReJv/71z3oPCpC1kFqKZxWA7No7Ak4FOyj7y2Q9pY3/cF9GXO5NyK9GN09UMpDHqMkoD0iIAn3M5jd9r/FCxnMCbprw4yYqqrs8/R2S6QufoFJU5QLAMSCpAmuUQSusJqZzepdrNL3bRbtQSPuyrSNPU7GMMh/U1LfkpE8LI5oRW2FkVadsDVW4t3WYRIhCDtdBvFqWFPFhzgD4vuq33UDiJVz25l3xonrXGF0ldb8cO3cERenQPcPyHAv1R6FF8AhbJLhhGVO4aAAAAAElFTkSuQmCC';
const ICON_ZOOM_OUT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAD9QTFRFAAAAFyMj///D//uPS2Njb4ODg5eX//Nfn6+vt8PD09vb7/Pz/+cv88sb16cTv4sPp28Hdz8AL0NDW3NzP1NTB/dKQgAAAAF0Uk5TAEDm2GYAAADnSURBVHjazZLLTsMwFETnONdpHi2FtP//hWwQCNoo5JJEIUJOKBsWPbOxNKMjW7LuANKz/zpgivpkki09hBAQsd80QCBDrk/PWk8NU28WAF2tHxwpQ11UdVVqJLc9WgjLBPcPjbSs7gAhhrbTzK4r3zwxcFGf12HI/nC4/lTYt+hSomoIIEgHuCqQHI3xtcGL/l0T1mnXKYUszm9UVRTxuH6muVNOPfSOVrCz2VDm9kizuYgaiUPPaXOxt5hHezgOfV43W/+hRuJVT+HFuuOz1jAiqTnZuUE34AwndAvg/A8L9MdC98IX3CQsGlCT6RUAAAAASUVORK5CYII=';
const ICON_PREVIOUS = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAARpQTFRFAAAAi99zN58XW78/Uqw5Uao4Wbs+fcxn////6+zrY69PXsBCbMZTi9J37Ozsc7Rgc8hb4ePg5ubm/Pz84+Pj39/fUak4XbRGd71k/v7+9vf29fb1gM1q3uLd6erp7e3tcq9ha75UWr0/VK86fb9q9vb15ufmXaFKZcNKXL9BcbNe5+nmVaFAhc9w4+fi2traZ7RRbsZVWKlDhbh20NTPU6866OznYqtN6urqP4UsTJ80o9uT1dXVsbGxQ44vTaE1V7g9Y8JId8pfk9SB+vr6ycrJUZo85eblRHw0R5QxWLg9Y8JJhM9v+Pj3zc3Nubm5XqhI9/j2UIVBQootWLk9fMxlk9WBVLE68PDwkMSB7vLtablTR68nb89Xd3lGMgAAAAF0Uk5TAEDm2GYAAAEkSURBVHjardM/S8NgEMfx5xtSKUmL6OIfRAQR0UEDdpR2rZPi5uDbUwdBUEFEnESnKjgUNYMguigEnVK1JPV5EgfBe5qlWX7k8iEcxx2q4KEYgB2lpP+BeSWxAxdjvmygDF2lhkg6FlCFWCkfiCRQrvBhcgReexKYgDeTY8CTAGbgWYe1Sfc3p4FQAM7cY16d5U4a1CIvscl5+AwFsEw7678yzI046pX776z/8XZHiaCUVwJoJSJwa9em4i/wEIlAed28VnPgQgJ1uDS5ehtwrrPPoBrAqQSavI+emX94cCTvw1rpJMtgEg4k0PQ4NOlPVcNIXpjGVZ5qfV8G9daSnscGx3Hfpd1kT/0Bztau7SycngZqeye1AP1dYdJ+WYW3OQjwA+U4biEmzoW0AAAAAElFTkSuQmCC';
const ICON_NEXT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAARpQTFRFAAAAi99zN58XW78/Wbs+Uao4Uqw5Y69P6+zr////fcxnbMZTc7Rg7Ozsi9J3XsBCUak439/f4+Pj/Pz85ubm4ePgc8hb9fb19vf2/v7+d71kXbRGWr0/a75Ucq9h7e3t6erp3uLdgM1q9vb1fb9qVK86XL9BZcNKXaFK5ufmVaFA5+nmcbNebsZVZ7RR2tra4+fihc9wU6860NTPhbh2WKlDYqtN6OznTJ80P4Us6urqsbGx1dXVo9uTV7g9TaE1Q44vUZo8ycrJ+vr6k9SBd8pfY8JIWLg9R5QxRHw05eblXqhIubm5zc3N+Pj3hM9vY8JJWLk9QootUIVB9/j2k9WBfMxlVLE6kMSB8PDwablT7vLtR68nb89XrxDnFwAAAAF0Uk5TAEDm2GYAAAEeSURBVHjardMxSwNBEIbheWOCgSNFbESxSyF4giBXCIqVgqhYCWLh39NOxNhGOytj0Ea0CAqCGBAPPA8uJqdZN0Ugs7km0+wH+ywMywySUWQDcKOUdACYk+4IkMeIxAmK0BEpdPORDkpALOLBhw4myhCaUCaKNDADtEyYhhd3k6ZmoamCCvBsI4kGROZp9u1jqoLKJDyZ4M1xrwGRJcI4NMHnVgVS9N9b/x0v3KiAABo2tlVQ8nmITQjqiQJWoVO3sfAtClinsXxtJbVhsAFcjfqoLYjN+83PKarDYA/ebP87PxfqPCx+vcYm7NKuamD/XGytXTpGztvmTCS4W6k5gBxwqg9t7vDEtRa53x6Qo+PUAXr3gjndm5W5m+MAf+hrdiHa73zsAAAAAElFTkSuQmCC';
const FAVICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NDAgNjQwIj48c3R5bGU+LmZ7ZmlsbDojMzM4MDAwfUBtZWRpYShwcmVmZXJzLWNvbG9yLXNjaGVtZTpkYXJrKXsuZntmaWxsOiM5OUZGNTV9fTwvc3R5bGU+PHBhdGggb3BhY2l0eT0iLjQiIGQ9Ik02NCAyNzJDNjQgMjEwLjEgMTE0LjIgMTYwIDE3NiAxNjBMMTc2IDU0NEw2NCA1NDRMNjQgMjcyek0yMDggMTYzLjRDMjM3LjYgMTcwLjkgMjYzLjQgMTkwLjIgMjc4LjYgMjE3LjZMMzA0IDI2My4zTDMwNCA1NDRMMjA4IDU0NEwyMDggMTYzLjR6TTMzNiAzMjAuOUwzNzAuNCAzODIuN0MzODQuNCA0MDcuOSA0MDYuMyA0MjcuMiA0MzIgNDM4TDQzMiA1NDMuOUwzMzYgNTQzLjlMMzM2IDMyMC44ek00NjQgNDQ2LjhDNDY5LjcgNDQ3LjYgNDc1LjQgNDQ4IDQ4MS4yIDQ0OEM1MTguOSA0NDggNTUyLjggNDMxLjUgNTc2IDQwNS40TDU3NiA1NDRMNDY0IDU0NEw0NjQgNDQ2Ljh6IiBjbGFzcz0iZiIvPjxwYXRoIGQ9Ik0xNzYgMTYwQzExNC4yIDE2MCA2NCAyMTAuMSA2NCAyNzJMNjQgNTQ0TDMyIDU0NEwzMiAyNzJDMzIgMTkyLjUgOTYuNSAxMjggMTc2IDEyOEwxODAuNyAxMjhDMjMzIDEyOCAyODEuMiAxNTYuNCAzMDYuNiAyMDIuMUwzOTguNCAzNjcuM0M0MTUuMSAzOTcuNCA0NDYuOCA0MTYuMSA0ODEuMyA0MTYuMUM1OTYuNyA0MTYuMSA2MTEgMjQxLjggNDk2LjEgMjI1LjFMNDk2LjEgMzY1LjdDNDkxLjQgMzY3LjMgNDg2LjUgMzY4LjEgNDgxLjMgMzY4LjFDNDc1LjMgMzY4LjEgNDY5LjUgMzY3IDQ2NC4xIDM2NC44TDQ2NC4xIDIyNS45QzQ0Ny42IDIyOS4yIDQzMi4xIDIzNi45IDQxOS41IDI0OC40TDQwNi45IDI1OS45TDM4NS40IDIzNi4yTDM5OCAyMjQuN0M0MjEuMSAyMDMuNyA0NTEuMyAxOTIgNDgyLjUgMTkyQzU1MS45IDE5MiA2MDguMSAyNDguMiA2MDguMSAzMTcuNkw2MDguMSA1NDRMNTc2LjEgNTQ0TDU3Ni4xIDQwNS40QzU1Mi45IDQzMS41IDUxOSA0NDggNDgxLjMgNDQ4QzQ3NS41IDQ0OCA0NjkuOCA0NDcuNiA0NjQuMSA0NDYuOEw0NjQuMSA1NDRMNDMyLjEgNTQ0TDQzMi4xIDQzOC4xQzQwNi40IDQyNy4zIDM4NC41IDQwOCAzNzAuNSAzODIuOEwzMzYuMSAzMjFMMzM2LjEgNTQ0LjFMMzA0LjEgNTQ0LjFMMzA0LjEgMjYzLjRMMjc4LjcgMjE3LjdDMjYzLjUgMTkwLjMgMjM3LjcgMTcwLjkgMjA4LjEgMTYzLjVMMjA4LjEgNTQ0LjFMMTc2LjEgNTQ0LjFMMTc2LjEgMTYwLjF6IiBjbGFzcz0iZiIvPjwvc3ZnPgo=';
const FONT_RCT2 = 'data:font/woff2;base64,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';

/**
 * Renders index.html. `domain` and `status` are not stored in timeline.json, so every caller must forward
 * the CLI values or the page loses its OG tags and status widget.
 */
function generateHtml(manifest: TimelineManifest, domain?: string, status?: string): string {
  const hasTimeline = manifest.timePoints.length > 1;
  const lastLabel = manifest.timePoints[manifest.timePoints.length - 1].label;
  const baseUrl = domain ? domain.replace(/\/$/, "") + "/" : undefined;
  const escLabel = lastLabel.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0d0d0d">
<meta name="description" content="OpenRCT2 Online Map">
<meta property="og:type" content="website">
<meta property="og:title" content="${escLabel}">
<meta property="og:description" content="OpenRCT2 Online Map">${baseUrl ? `
<meta property="og:url" content="${baseUrl}">
<meta property="og:image" content="${baseUrl}og-image.png">
<meta name="twitter:card" content="summary_large_image">` : ""}
<title>${lastLabel}</title>
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1/dist/leaflet.css">
<script src="https://cdn.jsdelivr.net/npm/leaflet@1/dist/leaflet.js"><\/script>
<style>
  @font-face {
    font-family: 'RCT2';
    src: url('${FONT_RCT2}') format('woff2');
    font-weight: normal;
    font-style: normal;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #map { width: 100%; height: 100vh; background: #0d0d0d; position: relative; }
  .leaflet-tile { image-rendering: pixelated; }

  .rct2-control {
    display: flex;
    overflow: hidden;
  }
  .rct2-btn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    user-select: none;
    image-rendering: pixelated;
  }
  .rct2-btn:active { opacity: 0.7; }
  .rct2-btn.disabled { opacity: 0.3; cursor: not-allowed; }
  .rct2-btn.disabled:active { opacity: 0.3; }
  .rct2-btn img { width: 32px; height: 32px; image-rendering: pixelated; }

  .leaflet-control-zoom a {
    width: 32px !important;
    height: 32px !important;
    line-height: 32px !important;
    background: none !important;
    border: none !important;
    border-radius: 0 !important;
    image-rendering: pixelated;
  }
  .leaflet-control-zoom a:active { opacity: 0.7; }
  .leaflet-control-zoom a img { width: 32px; height: 32px; image-rendering: pixelated; }
  .leaflet-control-zoom { border: none !important; display: flex; flex-direction: column; gap: 2px; }

  .snapshot-label {
    position: absolute;
    bottom: 8px;
    left: 8px;
    color: #fff;
    font-family: 'RCT2', monospace;
    font-size: 13px;
    line-height: 1;
    text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
    pointer-events: none;
    z-index: 1000;
  }

  .server-status {
    max-width: calc(100vw - 72px);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: #fff;
    font-family: 'RCT2', monospace;
    font-size: 13px;
    line-height: 1;
    text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
  }
  .server-status::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 6px;
    background: #888;
    box-shadow: 1px 1px 2px rgba(0,0,0,0.8);
  }
  .server-status[data-state="online"]::before { background: #4c4; }
  .server-status[data-state="offline"]::before { background: #e33; }
</style>
</head>
<body>
<figure id="map">
<figcaption class="snapshot-label" id="snapshot-label"></figcaption>
</figure>
<script>
(function() {
  var CONFIG = ${JSON.stringify(manifest)};
  var maxZoom = CONFIG.maxZoom;

  var hash = new URLSearchParams(location.hash.slice(1));
  var initIdx = parseInt(hash.get('t'), 10);
  var currentIdx = isNaN(initIdx) ? CONFIG.timePoints.length - 1 : Math.min(Math.max(initIdx, 0), CONFIG.timePoints.length - 1);

  // Union of all timepoint extents in CRS units; each timepoint's maxZoom gives it its own scale.
  var globalW = 0, globalH = 0;
  CONFIG.timePoints.forEach(function(tp) {
    var z = tp.maxZoom !== undefined ? tp.maxZoom : maxZoom;
    var w = tp.imageWidth !== undefined ? tp.imageWidth : CONFIG.imageWidth;
    var h = tp.imageHeight !== undefined ? tp.imageHeight : CONFIG.imageHeight;
    var s = Math.pow(2, z);
    globalW = Math.max(globalW, w / s);
    globalH = Math.max(globalH, h / s);
  });
  var bounds = L.latLngBounds(
    L.latLng(-globalH, 0),
    L.latLng(0, globalW)
  );

  var map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: maxZoom,
    zoomControl: false,
    attributionControl: false,
  });

  var initRot = parseInt(hash.get('r'), 10);
  var currentRotation = CONFIG.rotations.includes(initRot) ? initRot : CONFIG.rotations[0];
  var currentTimestamp = CONFIG.timePoints[currentIdx].timestamp;
  var labelEl = document.getElementById('snapshot-label');
  labelEl.textContent = CONFIG.timePoints[currentIdx].label;
  document.title = CONFIG.timePoints[currentIdx].label;

  var hashTimeout;
  function updateHash() {
    clearTimeout(hashTimeout);
    hashTimeout = setTimeout(function() {
      var c = map.getCenter();
      history.replaceState(null, '', '#' + new URLSearchParams({
        z: map.getZoom(), lat: c.lat.toFixed(2), lng: c.lng.toFixed(2), r: currentRotation, t: currentIdx,
      }));
    }, 150);
  }
  map.on('moveend', updateHash);

  function makeTileLayers(timestamp, tpMaxZoom, tpWidth, tpHeight) {
    var layers = {};
    var tpScale = Math.pow(2, tpMaxZoom);
    var tpBounds = L.latLngBounds(
      L.latLng(-tpHeight / tpScale, 0),
      L.latLng(0, tpWidth / tpScale)
    );
    CONFIG.rotations.forEach(function(rot) {
      var opts = {
        minZoom: 0,
        maxZoom: maxZoom,
        tileSize: CONFIG.tileSize,
        noWrap: true,
        bounds: tpBounds,
      };
      if (tpMaxZoom < maxZoom) {
        opts.maxNativeZoom = tpMaxZoom;
      }
      // sharp's google layout writes {z}/{row}/{col}.png.
      layers[rot] = L.tileLayer('snapshots/' + timestamp + '/' + rot + '/{z}/{y}/{x}.png', opts);
    });
    return layers;
  }

  var layerCache = {};
  function getLayersForTimestamp(ts) {
    if (!layerCache[ts]) {
      var tp = CONFIG.timePoints.find(function(t) { return t.timestamp === ts; });
      var tpZ = tp && tp.maxZoom !== undefined ? tp.maxZoom : maxZoom;
      var tpW = tp && tp.imageWidth !== undefined ? tp.imageWidth : CONFIG.imageWidth;
      var tpH = tp && tp.imageHeight !== undefined ? tp.imageHeight : CONFIG.imageHeight;
      layerCache[ts] = makeTileLayers(ts, tpZ, tpW, tpH);
    }
    return layerCache[ts];
  }

  var tileLayers = getLayersForTimestamp(currentTimestamp);
  tileLayers[currentRotation].addTo(map);

  function rotateView() {
    var idx = CONFIG.rotations.indexOf(currentRotation);
    var nextIdx = (idx + 1) % CONFIG.rotations.length;
    var nextRot = CONFIG.rotations[nextIdx];

    // Current timepoint's CRS dimensions (not global max)
    var tp = CONFIG.timePoints[currentIdx];
    var tpZ = tp.maxZoom !== undefined ? tp.maxZoom : maxZoom;
    var tpS = Math.pow(2, tpZ);
    var tpW = (tp.imageWidth !== undefined ? tp.imageWidth : CONFIG.imageWidth) / tpS;
    var tpH = (tp.imageHeight !== undefined ? tp.imageHeight : CONFIG.imageHeight) / tpS;

    // Treats each step as a 90° turn, which maps the center's fractional position (fx right, fy down) to (1 - fy, fx).
    var center = map.getCenter();
    var fx = center.lng / tpW;
    var fy = -center.lat / tpH;
    var newFx = 1 - fy;
    var newFy = fx;

    map.removeLayer(tileLayers[currentRotation]);
    currentRotation = nextRot;
    tileLayers = getLayersForTimestamp(currentTimestamp);
    tileLayers[currentRotation].addTo(map);
    map.setView(L.latLng(-newFy * tpH, newFx * tpW), map.getZoom());
    updateHash();
  }
  var initLat = parseFloat(hash.get('lat')), initLng = parseFloat(hash.get('lng')), initZoom = parseInt(hash.get('z'), 10);
  if (isFinite(initLat) && isFinite(initLng) && isFinite(initZoom)) map.setView([initLat, initLng], initZoom);
  else map.fitBounds(bounds);
  map.setMaxBounds(bounds.pad(0.1));

  var ICON_ROTATE = '${ICON_ROTATE}';
  var ICON_ZOOM_IN = '${ICON_ZOOM_IN}';
  var ICON_ZOOM_OUT = '${ICON_ZOOM_OUT}';
  var ICON_PREVIOUS = '${ICON_PREVIOUS}';
  var ICON_NEXT = '${ICON_NEXT}';

  var RotationControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      var container = L.DomUtil.create('div', 'rct2-control leaflet-bar');
      L.DomEvent.disableClickPropagation(container);
      var btn = L.DomUtil.create('button', 'rct2-btn', container);
      btn.innerHTML = '<img src="' + ICON_ROTATE + '" alt="Rotate">';
      btn.title = 'Rotate view';
      btn.setAttribute('aria-label', 'Rotate view');
      L.DomEvent.on(btn, 'click', rotateView);
      return container;
    },
  });

  if (CONFIG.rotations.length > 1) new RotationControl().addTo(map);
${hasTimeline ? `
  var prevBtnEl, nextBtnEl;

  function updateTimelineBtns() {
    if (currentIdx <= 0) {
      prevBtnEl.classList.add('disabled');
    } else {
      prevBtnEl.classList.remove('disabled');
    }
    if (currentIdx >= CONFIG.timePoints.length - 1) {
      nextBtnEl.classList.add('disabled');
    } else {
      nextBtnEl.classList.remove('disabled');
    }
  }

  function switchToTimepoint(idx) {
    map.removeLayer(tileLayers[currentRotation]);
    currentIdx = idx;
    currentTimestamp = CONFIG.timePoints[idx].timestamp;
    tileLayers = getLayersForTimestamp(currentTimestamp);
    tileLayers[currentRotation].addTo(map);
    labelEl.textContent = CONFIG.timePoints[idx].label;
    document.title = CONFIG.timePoints[idx].label;
    updateTimelineBtns();
    updateHash();
  }

  var TimelineControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      var container = L.DomUtil.create('div', 'rct2-control leaflet-bar');
      container.style.flexDirection = 'column';
      L.DomEvent.disableClickPropagation(container);

      prevBtnEl = L.DomUtil.create('button', 'rct2-btn', container);
      prevBtnEl.innerHTML = '<img src="' + ICON_PREVIOUS + '" alt="Previous">';
      prevBtnEl.title = 'Previous snapshot';
      prevBtnEl.setAttribute('aria-label', 'Previous snapshot');
      L.DomEvent.on(prevBtnEl, 'click', function() {
        if (currentIdx > 0) switchToTimepoint(currentIdx - 1);
      });

      nextBtnEl = L.DomUtil.create('button', 'rct2-btn', container);
      nextBtnEl.innerHTML = '<img src="' + ICON_NEXT + '" alt="Next">';
      nextBtnEl.title = 'Next snapshot';
      nextBtnEl.setAttribute('aria-label', 'Next snapshot');
      L.DomEvent.on(nextBtnEl, 'click', function() {
        if (currentIdx < CONFIG.timePoints.length - 1) switchToTimepoint(currentIdx + 1);
      });

      return container;
    },
  });

  new TimelineControl().addTo(map);
  updateTimelineBtns();
` : ''}
  L.control.zoom({
    position: 'topleft',
    zoomInText: '<img src="' + ICON_ZOOM_IN + '" alt="Zoom in">',
    zoomOutText: '<img src="' + ICON_ZOOM_OUT + '" alt="Zoom out">',
  }).addTo(map);
${status ? `
  // The master server list includes only servers with advertise = true.
  // Accept: application/json is required, or the endpoint serves its HTML page.
  var STATUS_NAME = ${JSON.stringify(status).replace(/</g, "\\u003c")};
  function plainName(s) { return s.replace(/[{][^}]*[}]/g, '').replace(/\\s+/g, ' ').trim(); }
  var statusLabel = plainName(STATUS_NAME);
  var statusKey = statusLabel.toLowerCase();

  var StatusControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
      var el = L.DomUtil.create('div', 'server-status');
      el.setAttribute('role', 'status');
      L.DomEvent.disableClickPropagation(el);
      return el;
    },
  });
  var statusEl = new StatusControl().addTo(map).getContainer();

  function showStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = statusLabel + ': ' + text;
    statusEl.title = statusEl.textContent;
  }

  function refreshStatus() {
    if (document.hidden) return;
    fetch('https://servers.openrct2.io/', { headers: { Accept: 'application/json' }, cache: 'no-cache', signal: AbortSignal.timeout(10000) })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        var server = data.servers.find(function(s) { return plainName(s.name).toLowerCase() === statusKey; });
        if (server) showStatus('online', 'Online (' + server.players + '/' + server.maxPlayers + ')');
        else showStatus('offline', 'Offline');
      })
      .catch(function() { showStatus('unknown', 'Unknown'); });
  }

  showStatus('unknown', 'Checking');
  refreshStatus();
  setInterval(refreshStatus, 60000);
  document.addEventListener('visibilitychange', refreshStatus);
` : ''}
  // Capture phase on window runs before Leaflet's document listener, so stopPropagation keeps a timeline step from also panning.
  // switchToTimepoint exists only with a timeline; with one time point the index checks never reach it.
  window.addEventListener('keydown', function(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === 'r' && CONFIG.rotations.length > 1) rotateView();
    else if (e.key === 'ArrowLeft' && currentIdx > 0) { e.stopPropagation(); switchToTimepoint(currentIdx - 1); }
    else if (e.key === 'ArrowRight' && currentIdx < CONFIG.timePoints.length - 1) { e.stopPropagation(); switchToTimepoint(currentIdx + 1); }
  }, true);
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function computeSnapshotHash(pngPaths: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const p of [...pngPaths].sort()) {
    hash.update(fs.readFileSync(p));
  }
  return hash.digest("hex");
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  // Relative symlink targets would climb out through any symlink in the -o path.
  outputDir = fs.realpathSync(outputDir);

  if (listSnapshots) {
    const manifest = requireManifest(outputDir);
    if (manifest.timePoints.length === 0) {
      console.error("No snapshots found in output directory.");
      process.exit(1);
    }
    for (const tp of manifest.timePoints) {
      console.log(`${tp.timestamp}  ${tp.label}`);
    }
    return;
  }

  if (renameTimestamp) {
    const manifest = requireManifest(outputDir);
    const tp = manifest.timePoints.find(tp => tp.timestamp === renameTimestamp);
    if (!tp) {
      console.error(`Error: Snapshot '${renameTimestamp}' not found in timeline.`);
      console.error(`Available: ${manifest.timePoints.map(tp => tp.timestamp).join(", ")}`);
      process.exit(1);
    }
    if (!values.label) {
      console.error("Error: --rename requires --label <text> for the new label.");
      process.exit(1);
    }
    tp.label = snapshotLabel;
    writeManifest(outputDir, manifest);
    fs.writeFileSync(path.join(outputDir, "index.html"), generateHtml(manifest, domain, statusName));
    console.error(`Renamed snapshot '${renameTimestamp}' to '${snapshotLabel}'.`);
    return;
  }

  if (removeTimestamp) {
    removeSnapshot(outputDir, removeTimestamp, domain, statusName);
    return;
  }

  cleanupStaleArtifacts(outputDir);

  // --clear deletes the old snapshots only once new screenshots exist.
  let manifest = clearSnapshots ? null : readManifest(outputDir);

  // The viewer applies one rotation set and tile size to every snapshot.
  if (manifest && manifest.timePoints.length > 0) {
    const had = `--rotations ${[...manifest.rotations].sort().join(",")} --tile-size ${manifest.tileSize}`;
    const wants = `--rotations ${[...rotations].sort().join(",")} --tile-size ${tileSize}`;
    if (had !== wants) {
      console.error(`Error: Existing snapshots use ${had}, but this run uses ${wants}.`);
      console.error("Pass the matching flags, or --clear to start over.");
      process.exit(1);
    }
  }

  // The save hash covers only the save file, so re-rendering an unchanged save with new flags needs --force.
  const saveHash = crypto.createHash("sha256").update(fs.readFileSync(inputFile)).digest("hex");
  if (!forceSnapshot && manifest && manifest.timePoints.length > 0) {
    const lastSaveHash = manifest.timePoints[manifest.timePoints.length - 1].saveHash;
    if (lastSaveHash && lastSaveHash === saveHash) {
      console.error("Save file unchanged since last snapshot — skipping. Use --force to save anyway.");
      return;
    }
  }

  // Render setup sits past the early-out so unchanged saves skip discovery and downloads.
  // The screenshot subcommand rejects --rct2-data-path, so game paths go in a throwaway config.ini
  // under XDG_CONFIG_HOME. Only OpenRCT2's Linux build reads XDG_CONFIG_HOME.
  const configLines = ["[general]"];
  if (process.platform === "linux") {
    let rct2DataPath = values["rct2-data-path"] ?? findRCT2Data();
    let rct1DataPath = values["rct1-data-path"] ?? findRCT1Data();
    if (!rct2DataPath) {
      try {
        await downloadGameAssets();
        rct2DataPath = findRCT2Data();
        rct1DataPath ??= findRCT1Data();
      } catch (err: any) {
        console.error(`Warning: Asset auto-download failed: ${err.message}`);
      }
    }
    if (!rct2DataPath) {
      console.error("Error: Could not auto-detect RCT2 data (Data/g1.dat not found).");
      console.error("Use --rct2-data-path <dir>, or set game_path in OpenRCT2's own config.ini.");
      process.exit(1);
    }
    console.error(`RCT2 data: ${path.resolve(rct2DataPath)}`);
    configLines.push(`game_path = "${path.resolve(rct2DataPath)}"`);
    if (rct1DataPath) {
      console.error(`RCT1 data: ${path.resolve(rct1DataPath)}`);
      configLines.push(`rct1_path = "${path.resolve(rct1DataPath)}"`);
    }
  } else {
    console.error("On this platform OpenRCT2 reads game_path from its own config.ini; --rct2-data-path and --rct1-data-path are ignored.");
  }

  // Update a portable OpenRCT2 in cwd, or download one if none was found; never replace a system install.
  let openrct2Bin = values.openrct2 ?? findOpenRCT2();
  if (!values.openrct2 && (openrct2Bin === "openrct2" || openrct2Bin.startsWith(process.cwd() + path.sep))) {
    try {
      openrct2Bin = (await downloadPortableOpenRCT2()) ?? openrct2Bin;
    } catch (err: any) {
      console.error(`Warning: OpenRCT2 auto-download failed: ${err.message}`);
    }
  }
  console.error(`OpenRCT2 binary: ${openrct2Bin}`);

  const timestamp = makeTimestamp();
  const snapshotDir = path.join(outputDir, "snapshots", timestamp);
  const giantPngs: { rotation: number; zoom: number; path: string }[] = [];
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrct2-map-"));
  try {
    fs.mkdirSync(path.join(configDir, "OpenRCT2"));
    fs.writeFileSync(path.join(configDir, "OpenRCT2", "config.ini"), configLines.join("\n") + "\n");

    console.error(`Generating screenshots (${ozRange.length > 1 ? `native zoom ${ozRange.join(",")}` : `zoom ${ozRange[0]}`})...`);
    for (const rot of rotations) {
      for (const oz of ozRange) {
        const pngPath = await generateScreenshot(rot, oz, openrct2Bin, configDir);
        giantPngs.push({ rotation: rot, zoom: oz, path: pngPath });
      }
    }

    // A changed save can still render identically, e.g. when only guests moved under --no-peeps.
    const snapshotHash = computeSnapshotHash(giantPngs.map(g => g.path));
    if (!forceSnapshot && manifest && manifest.timePoints.length > 0) {
      const lastHash = manifest.timePoints[manifest.timePoints.length - 1].hash;
      if (lastHash && lastHash === snapshotHash) {
        console.error("\nMap unchanged since last snapshot — skipping. Use --force to save anyway.");
        return;
      }
    }
    if (clearSnapshots) {
      fs.rmSync(path.join(outputDir, "snapshots"), { recursive: true, force: true });
      fs.rmSync(path.join(outputDir, "timeline.json"), { force: true });
      console.error("Cleared existing snapshots.");
    }
    fs.mkdirSync(snapshotDir, { recursive: true });

    console.error("\nGenerating tile pyramids...");
    const metadataList: TileMetadata[] = [];
    for (const rot of rotations) {
      const pngsForRot = giantPngs
        .filter(g => g.rotation === rot)
        .map(({ zoom, path }) => ({ zoom, path }));
      const meta = await assembleNativeTiles(pngsForRot, rot, snapshotDir);
      metadataList.push(meta);
      console.error(
        `  -> rotation ${rot}: z=0-${meta.maxZoom} (${meta.maxZoom + 1} zoom levels)`,
      );
    }

    // Must run before dedup: dedup compares final bytes, and writing through its symlinks would rewrite older snapshots.
    if (usePalette) {
      console.error("\nQuantizing tiles to indexed color...");
      await palettizeTiles(snapshotDir);
    }

    if (manifest && manifest.timePoints.length > 0) {
      const prevTimestamp = manifest.timePoints[manifest.timePoints.length - 1].timestamp;
      const prevSnapshotDir = path.join(outputDir, "snapshots", prevTimestamp);
      if (fs.existsSync(prevSnapshotDir)) {
        console.error("\nDeduplicating tiles...");
        const { total, deduped } = deduplicateSnapshot(snapshotDir, prevSnapshotDir);
        const pct = total > 0 ? ((deduped / total) * 100).toFixed(1) : "0";
        console.error(`  ${deduped}/${total} tiles symlinked (${pct}% saved)`);
      }
    }

    manifest ??= { timePoints: [], rotations, tileSize, maxZoom: 0, imageWidth: 0, imageHeight: 0 };
    manifest.timePoints.push({
      timestamp,
      label: snapshotLabel,
      hash: snapshotHash,
      saveHash,
      maxZoom: Math.max(...metadataList.map(m => m.maxZoom)),
      imageWidth: Math.max(...metadataList.map(m => m.width)),
      imageHeight: Math.max(...metadataList.map(m => m.height)),
    });
    manifest.rotations = rotations;
    manifest.tileSize = tileSize;
    updateExtents(manifest);
    writeManifest(outputDir, manifest);

    // Crawlers need og:image as an absolute URL, so the preview is written only with --domain.
    if (domain) {
      // Finest zoom of the first requested rotation gives the sharpest preview.
      const ogSource = giantPngs.find(g => g.rotation === rotations[0] && g.zoom === ozRange[0])!;
      // 2:1 downscale (crop 2400x1260, halve to 1200x630); fall back to 1:1 for small images
      const ogPath = path.join(outputDir, "og-image.png");
      const ogMeta = await sharp(ogSource.path, { limitInputPixels: false }).metadata();
      const use2x = ogMeta.width! >= 2400 && ogMeta.height! >= 1260;
      const ogCropW = Math.min(use2x ? 2400 : 1200, ogMeta.width!);
      const ogCropH = Math.min(use2x ? 1260 : 630, ogMeta.height!);
      let ogPipeline = sharp(ogSource.path, { limitInputPixels: false })
        .extract({
          left: Math.floor((ogMeta.width! - ogCropW) / 2),
          top: Math.floor((ogMeta.height! - ogCropH) / 2),
          width: ogCropW,
          height: ogCropH,
        });
      if (use2x) {
        ogPipeline = ogPipeline.resize(ogCropW / 2, ogCropH / 2, { kernel: "nearest" });
      }
      await ogPipeline.png({ compressionLevel: 6 }).toFile(ogPath);
      console.error(`OG image written to ${ogPath}`);
    }

    const htmlPath = path.join(outputDir, "index.html");
    fs.writeFileSync(htmlPath, generateHtml(manifest, domain, statusName));
    console.error(`Viewer written to ${htmlPath}`);
  } finally {
    for (const { path: pngPath } of giantPngs) {
      try { fs.unlinkSync(pngPath); } catch {}
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }

}

main().catch((err) => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
