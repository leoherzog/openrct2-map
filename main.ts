import { parseArgs, promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import sharp from "sharp";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Auto-discovery helpers
// ---------------------------------------------------------------------------

function findDataDir(validationFile: string, candidates: string[]): string | undefined {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, validationFile))) return dir;
  }
  return undefined;
}

function makeTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getSteamCommonDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case "linux":
      return [
        path.join(home, ".local", "share", "Steam", "steamapps", "common"),
        path.join(home, "snap", "steam", "common", ".local", "share", "Steam", "steamapps", "common"),
      ];
    case "win32":
      return [
        "C:\\Program Files (x86)\\Steam\\steamapps\\common",
      ];
    case "darwin":
      return [
        path.join(home, "Library", "Application Support", "Steam", "steamapps", "common"),
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// OpenRCT2 binary discovery
// ---------------------------------------------------------------------------

function findOpenRCT2(): string {
  // 1. Look for AppImage/exe in cwd (newest version first)
  const entries = fs.readdirSync(process.cwd());
  const binaries = entries
    .filter((e) => /^OpenRCT2-.*\.(AppImage|exe)$/i.test(e))
    .sort()
    .reverse();
  if (binaries.length > 0) {
    return path.resolve(binaries[0]);
  }

  // 2. Well-known install paths
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

  // 3. Fall back to openrct2 on PATH
  return "openrct2";
}

// ---------------------------------------------------------------------------
// Game data discovery
// ---------------------------------------------------------------------------

function findGameData(
  validationFile: string,
  steamNames: string[],
  gogNames: string[],
): string | undefined {
  const candidates: string[] = [path.join(process.cwd(), "assets", "RCT")];
  for (const base of getSteamCommonDirs()) {
    for (const name of steamNames) candidates.push(path.join(base, name));
  }
  if (process.platform === "win32") {
    for (const name of gogNames) {
      candidates.push(`C:\\GOG Games\\${name}`);
      candidates.push(`C:\\Program Files (x86)\\GalaxyClient\\Games\\${name}`);
    }
  }
  return findDataDir(validationFile, candidates);
}

function findRCT2Data(): string | undefined {
  return findGameData(
    path.join("Data", "g1.dat"),
    ["Rollercoaster Tycoon 2", "RollerCoaster Tycoon Classic"],
    ["RollerCoaster Tycoon 2 Triple Thrill Pack", "RollerCoaster Tycoon 2"],
  );
}

function findRCT1Data(): string | undefined {
  return findGameData(
    path.join("Data", "csg1.dat"),
    ["RollerCoaster Tycoon Deluxe"],
    ["RollerCoaster Tycoon Deluxe"],
  );
}

// ---------------------------------------------------------------------------
// Screenshot flag enumeration
// ---------------------------------------------------------------------------

async function getScreenshotFlags(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(bin, ["-ha"], { timeout: 10_000 });
    const lines = stdout.split("\n");

    // Find the screenshot section header: a line of dashes, then "screenshot"
    let sectionStart = -1;
    for (let i = 1; i < lines.length; i++) {
      if (/^screenshot\s*$/.test(lines[i]) && /^-{3,}\s*$/.test(lines[i - 1])) {
        sectionStart = i;
        break;
      }
    }
    if (sectionStart === -1) return null;

    // Skip closing dashes of the section header (------\nscreenshot\n------)
    let contentStart = sectionStart + 1;
    if (/^-{3,}\s*$/.test(lines[contentStart] ?? "")) contentStart++;

    // Collect flag lines (start with whitespace + --)
    const flagLines: string[] = [];
    for (let i = contentStart; i < lines.length; i++) {
      const line = lines[i];
      // Stop at the next section header (a line of dashes)
      if (/^-{3,}\s*$/.test(line)) break;
      // Flag lines start with whitespace and --
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
// Timeline manifest
// ---------------------------------------------------------------------------

interface TimePoint {
  timestamp: string;
  label: string;
  hash?: string;
  maxZoom?: number;
  imageWidth?: number;
  imageHeight?: number;
}

interface TimelineManifest {
  timePoints: TimePoint[];
  rotations: number[];
  maxZoom: number;
  imageWidth: number;
  imageHeight: number;
  tileSize?: number;
}

function readManifest(dir: string): TimelineManifest | null {
  const p = path.join(dir, "timeline.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function requireManifest(dir: string): TimelineManifest {
  const manifest = readManifest(dir);
  if (!manifest) {
    console.error("Error: No timeline.json found in output directory.");
    process.exit(1);
  }
  return manifest;
}

function writeManifest(dir: string, manifest: TimelineManifest): void {
  fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

function migrateLegacyOutput(outputDir: string, rotations: number[]): void {
  const tilesDir = path.join(outputDir, "tiles");
  const manifestPath = path.join(outputDir, "timeline.json");
  if (!fs.existsSync(tilesDir) || fs.existsSync(manifestPath)) return;

  console.error("Migrating legacy output directory to timeline format...");
  const timestamp = "migrated";
  const snapshotsDir = path.join(outputDir, "snapshots");
  fs.mkdirSync(snapshotsDir, { recursive: true });
  fs.renameSync(tilesDir, path.join(snapshotsDir, timestamp));

  const snapshotDir = path.join(snapshotsDir, timestamp);
  const rotationDirs = fs.readdirSync(snapshotDir).filter(d => /^\d+$/.test(d)).map(Number).sort();

  // Determine maxZoom from the first rotation
  const firstRotDir = path.join(snapshotDir, String(rotationDirs[0]));
  const zoomDirs = fs.readdirSync(firstRotDir).filter(d => /^\d+$/.test(d)).map(Number);
  const maxZoom = Math.max(...zoomDirs);

  // Estimate image dimensions from the tile grid at max zoom
  const maxZoomDir = path.join(firstRotDir, String(maxZoom));
  const rows = fs.readdirSync(maxZoomDir).filter(d => /^\d+$/.test(d)).map(Number);
  const maxRow = rows.length > 0 ? Math.max(...rows) + 1 : 0;
  let maxCol = 0;
  for (const row of rows) {
    const cols = fs.readdirSync(path.join(maxZoomDir, String(row))).filter(f => f.endsWith(".png")).length;
    if (cols > maxCol) maxCol = cols;
  }
  const estimatedWidth = maxCol * 256;
  const estimatedHeight = maxRow * 256;

  const manifest: TimelineManifest = {
    timePoints: [{ timestamp, label: "Initial" }],
    rotations: rotationDirs.length > 0 ? rotationDirs : rotations,
    maxZoom,
    imageWidth: estimatedWidth,
    imageHeight: estimatedHeight,
  };
  writeManifest(outputDir, manifest);
  console.error("  Legacy output migrated. Previous tiles are now under snapshots/migrated/");
}

// ---------------------------------------------------------------------------
// Symlink-based deduplication
// ---------------------------------------------------------------------------

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

        // Resolve through any existing symlinks to get the real file
        const prevReal = fs.realpathSync(prevPath);
        const newContent = fs.readFileSync(fullPath);
        const prevContent = fs.readFileSync(prevReal);

        if (newContent.equals(prevContent)) {
          // Use relative symlink target so output dir is relocatable
          const relTarget = path.relative(path.dirname(fullPath), prevReal);
          fs.unlinkSync(fullPath);
          fs.symlinkSync(relTarget, fullPath);
          deduped++;
        }
      }
    }
  }

  walkDir(newSnapshotDir);
  return { total, deduped };
}

// ---------------------------------------------------------------------------
// Snapshot removal
// ---------------------------------------------------------------------------

function materializeSymlinksPointingTo(dir: string, targetPrefix: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      materializeSymlinksPointingTo(fullPath, targetPrefix);
    } else if (entry.isSymbolicLink()) {
      const realTarget = fs.realpathSync(fullPath);
      if (realTarget.startsWith(targetPrefix + path.sep) || realTarget === targetPrefix) {
        const content = fs.readFileSync(fullPath);
        fs.unlinkSync(fullPath);
        fs.writeFileSync(fullPath, content);
      }
    }
  }
}

function removeSnapshot(outputDir: string, timestamp: string, domain?: string): void {
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

  const doomedDir = path.join(outputDir, "snapshots", timestamp);
  if (!fs.existsSync(doomedDir)) {
    console.error(`Error: Snapshot directory not found: ${doomedDir}`);
    process.exit(1);
  }

  const doomedReal = fs.realpathSync(doomedDir);

  // Materialize symlinks in other snapshots that point into the doomed directory
  const snapshotsDir = path.join(outputDir, "snapshots");
  for (const otherTs of fs.readdirSync(snapshotsDir)) {
    if (otherTs === timestamp) continue;
    materializeSymlinksPointingTo(path.join(snapshotsDir, otherTs), doomedReal);
  }

  fs.rmSync(doomedDir, { recursive: true, force: true });

  manifest.timePoints.splice(idx, 1);
  writeManifest(outputDir, manifest);

  fs.writeFileSync(path.join(outputDir, "index.html"), generateHtml(manifest, domain));

  console.error(`Removed snapshot '${timestamp}'. ${manifest.timePoints.length} snapshot(s) remain.`);
}

// ---------------------------------------------------------------------------
// Stale artifact cleanup
// ---------------------------------------------------------------------------

function cleanupStaleArtifacts(outputDir: string): void {
  if (!fs.existsSync(outputDir)) return;

  // 1. Giant PNGs left by crashed screenshot phase
  for (const entry of fs.readdirSync(outputDir)) {
    if (/^giant_r\d+_z\d+\.png$/.test(entry)) {
      fs.unlinkSync(path.join(outputDir, entry));
      console.error(`Cleaned up stale screenshot: ${entry}`);
    }
  }

  const snapshotsDir = path.join(outputDir, "snapshots");
  if (!fs.existsSync(snapshotsDir)) return;

  // 2. .tmp-nz-* dirs left by crashed native zoom assembly
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

  // 3. Orphaned snapshot dirs (on disk but not in timeline.json)
  const manifest = readManifest(outputDir);
  const knownTimestamps = new Set(manifest?.timePoints.map(tp => tp.timestamp) ?? []);
  for (const dirName of fs.readdirSync(snapshotsDir)) {
    const dirPath = path.join(snapshotsDir, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    if (knownTimestamps.has(dirName)) continue;

    // Materialize symlinks in other snapshots that point into the orphan
    const orphanReal = fs.realpathSync(dirPath);
    for (const otherDir of fs.readdirSync(snapshotsDir)) {
      if (otherDir === dirName) continue;
      const otherPath = path.join(snapshotsDir, otherDir);
      if (fs.statSync(otherPath).isDirectory()) {
        materializeSymlinksPointingTo(otherPath, orphanReal);
      }
    }

    fs.rmSync(dirPath, { recursive: true, force: true });
    console.error(`Cleaned up orphaned snapshot: ${dirName}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
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
    "skip-blanks": { type: "string", default: "-1" },
    concurrency: { type: "string" },
    "single-zoom": { type: "boolean", default: false },
    domain: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  // Everything after -- is collected in positionals (extra flags for openrct2)
  strict: false,
});

const outputDir = path.resolve(values.output as string);
const listSnapshots = values.list as boolean;
const renameTimestamp = values.rename as string | undefined;
const removeTimestamp = values.remove as string | undefined;
const clearSnapshots = values.clear as boolean;
const forceSnapshot = values.force as boolean;
const singleZoom = values["single-zoom"] as boolean;
const openrct2Bin = (values.openrct2 as string | undefined) ?? findOpenRCT2();
function requireInt(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n)) { console.error(`Error: --${name} must be a number, got '${value}'`); process.exit(1); }
  return n;
}

const tileSize = requireInt(values["tile-size"] as string, "tile-size");
const compressionLevel = requireInt(values.compression as string, "compression");
const pngEffort = values.effort !== undefined ? requireInt(values.effort as string, "effort") : undefined;
const usePalette = values.palette as boolean;
const skipBlanks = requireInt(values["skip-blanks"] as string, "skip-blanks");
const domain = values.domain as string | undefined;
if (values.concurrency !== undefined) {
  sharp.concurrency(requireInt(values.concurrency as string, "concurrency"));
}

if (values.help || (positionals.length === 0 && !listSnapshots && !renameTimestamp && !removeTimestamp)) {
  let helpText = `Usage: main.ts <savefile> [options] [-- openrct2-flags...]

Options:
  -o, --output <dir>       Output directory (default: ./output)
  --zoom <n>               Finest OpenRCT2 zoom level, 0 = closest (default: 1)
                           Renders at zoom n through 3 for native sprites at each level
  --rotations <list>       Comma-separated rotations to render (default: 0,1,2,3)
  --openrct2 <path>        Path to openrct2 binary/AppImage (default: auto-detect)
  --rct2-data-path <path>  Path to RCT2 data dir (containing Data/g1.dat) [auto-detected]
  --rct1-data-path <path>  Path to RCT1 data dir (containing Data/csg1.dat) [auto-detected]
  --label <text>           Label for this snapshot (default: current date/time)
  --list                   List all snapshots in the output directory
  --rename <timestamp>     Rename a snapshot label (use with --label)
  --remove <timestamp>     Remove a snapshot by its timestamp key
  --clear                  Clear all existing snapshots before generating
  --force                  Save snapshot even if map is unchanged from last run
  --tile-size <n>          Tile size in pixels (default: 256)
  --compression <0-9>      PNG compression level (default: 6, 0 = fastest)
  --effort <1-10>          PNG compression effort/strategy tuning
  --palette                Use indexed-color PNG (smaller files for pixel art)
  --skip-blanks <n>        Alpha threshold for skipping blank tiles (default: -1)
  --concurrency <n>        Sharp/libvips thread count (default: CPU cores)
  --single-zoom            Only render at the specified zoom level (skip native zoom pyramid)
  --domain <url>           Base URL for OG tags (e.g. https://example.com/map)
  -h, --help               Show this help

Screenshot defaults (applied unless you override that specific flag after --):
  --transparent, --tidy-up-park, --weather=1

Extra flags after -- are forwarded to openrct2 screenshot, e.g.:
  deno run -A main.ts park.park -o out -- --no-peeps
  deno run -A main.ts park.park -o out -- --weather=3  (overrides default sunny)`;

  console.error(`Using OpenRCT2: ${openrct2Bin}`);
  const screenshotFlags = await getScreenshotFlags(openrct2Bin);
  if (screenshotFlags) {
    helpText += `\n\nOpenRCT2 screenshot flags (pass after --):\n${screenshotFlags}`;
  }

  console.log(helpText);
  process.exit(0);
}

const rotations = (values.rotations as string).split(",").map(Number);
const snapshotLabel = (values.label as string | undefined) ?? new Date().toLocaleString();

// For --remove mode, we skip all save-file and game-data setup
let inputFile = "";
let zoomLevel = 1;
let rct2DataPath: string | undefined;
let rct1DataPath: string | undefined;
let tmpConfigDir = "";
let screenshotEnv: Record<string, string | undefined> = {};
let extraFlags: string[] = [];
let ozRange: number[] = [];

if (!listSnapshots && !renameTimestamp && !removeTimestamp) {
  inputFile = path.resolve(positionals[0]);
  zoomLevel = requireInt(values.zoom as string, "zoom");
  if (zoomLevel < 0 || zoomLevel > 3) {
    console.error("Error: --zoom must be between 0 and 3."); process.exit(1);
  }
  ozRange = singleZoom
    ? [zoomLevel]
    : Array.from({ length: 3 - zoomLevel + 1 }, (_, i) => zoomLevel + i);
  rct2DataPath = (values["rct2-data-path"] as string | undefined) ?? findRCT2Data();
  rct1DataPath = (values["rct1-data-path"] as string | undefined) ?? findRCT1Data();

  // Extra flags after -- are screenshot-specific (e.g. --transparent, --tidy-up-park)
  // Defaults are applied per-flag unless the user overrides that specific concern.
  const userFlags = positionals.slice(1);
  const hasFlag = (f: string) => userFlags.some((u) => u === f || u.startsWith(f + "="));
  const defaults: string[] = [];
  if (!hasFlag("--transparent")) defaults.push("--transparent");
  if (!hasFlag("--weather")) defaults.push("--weather=1");
  const tidyFlags = ["--tidy-up-park", "--clear-grass", "--water-plants", "--fix-vandalism", "--remove-litter"];
  if (!tidyFlags.some((f) => hasFlag(f))) defaults.push("--tidy-up-park");
  extraFlags = [...defaults, ...userFlags];

  console.error(`OpenRCT2 binary: ${openrct2Bin}`);
  if (rct2DataPath) console.error(`RCT2 data: ${path.resolve(rct2DataPath)}`);
  if (rct1DataPath) console.error(`RCT1 data: ${path.resolve(rct1DataPath)}`);

  if (!rct2DataPath) {
    console.error("Error: Could not auto-detect RCT2 data (Data/g1.dat not found).");
    console.error("Use --rct2-data-path <dir> or install RCT2 via Steam/GOG.");
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`Error: input file not found: ${inputFile}`);
    process.exit(1);
  }

  // Create a temporary XDG_CONFIG_HOME with a config.ini so OpenRCT2 finds the
  // game assets without touching the user's real config.
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrct2-map-"));
  const tmpOrct2Dir = path.join(tmpConfigDir, "OpenRCT2");
  fs.mkdirSync(tmpOrct2Dir);

  const configLines = [
    "[general]",
    `game_path = "${path.resolve(rct2DataPath)}"`,
  ];
  if (rct1DataPath) {
    configLines.push(`rct1_path = "${path.resolve(rct1DataPath)}"`);
  }
  fs.writeFileSync(path.join(tmpOrct2Dir, "config.ini"), configLines.join("\n") + "\n");

  screenshotEnv = { ...process.env, XDG_CONFIG_HOME: tmpConfigDir };
}

// ---------------------------------------------------------------------------
// Screenshot generation
// ---------------------------------------------------------------------------

let screenshotCounter = 0;

async function generateScreenshot(
  rotation: number,
  zoom: number,
): Promise<string> {
  const outPng = path.join(outputDir, `giant_r${rotation}_z${zoom}.png`);
  const args = [
    "screenshot",
    inputFile,
    outPng,
    "giant",
    String(zoom),
    String(rotation),
    ...extraFlags,
  ];

  const total = rotations.length * ozRange.length;
  console.error(`[${++screenshotCounter}/${total}] openrct2 ${args.join(" ")}`);

  try {
    await execFile(openrct2Bin, args, { timeout: 600_000, env: screenshotEnv });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.error(
        `Error: '${openrct2Bin}' not found. Install OpenRCT2 or use --openrct2 <path>.`,
      );
      process.exit(1);
    }
    const stderr = (err.stderr ?? "").trim();
    const exitInfo = typeof err.code === "number" ? `exit code ${err.code}`
      : err.code ? String(err.code) : "unknown error";
    console.error(`Error: openrct2 screenshot failed (${exitInfo}).`);
    if (stderr) console.error(stderr);
    process.exit(1);
  }

  return outPng;
}

// ---------------------------------------------------------------------------
// Tile pyramid generation
// ---------------------------------------------------------------------------

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

  const pngOpts: sharp.PngOptions = {
    compressionLevel,
    ...(usePalette && { palette: true }),
    ...(pngEffort !== undefined && { effort: pngEffort }),
  };

  await sharp(giantPng, { limitInputPixels: false })
    .png(pngOpts)
    .tile({
      size: tileSize,
      layout: "google",
      overlap: 0,
      skipBlanks: skipBlanks,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toFile(tileDir);

  // Determine maxZoom from the generated directory structure
  const zoomDirs = fs.readdirSync(tileDir)
    .filter((d) => /^\d+$/.test(d))
    .map(Number);
  const maxZoom = Math.max(...zoomDirs);

  return { rotation, width, height, maxZoom };
}

async function assembleNativeTiles(
  pngsForRotation: { zoom: number; path: string }[],
  rotation: number,
  targetBaseDir: string,
): Promise<TileMetadata> {
  // Sort by OZ level descending (most zoomed out first)
  const sorted = [...pngsForRotation].sort((a, b) => b.zoom - a.zoom);

  if (sorted.length === 1) {
    return generateTiles(sorted[0].path, rotation, targetBaseDir);
  }

  // Base pyramid from most zoomed-out OZ (full pyramid including downscales)
  const baseMeta = await generateTiles(sorted[0].path, rotation, targetBaseDir);
  console.error(`    Base pyramid from OZ${sorted[0].zoom}: z=0-${baseMeta.maxZoom}`);

  // Overlay native tiles from each closer OZ level
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

  // Use finest OZ dimensions — it defines the coordinate space for the viewer
  return { rotation, width: finestMeta.width, height: finestMeta.height, maxZoom: finestMeta.maxZoom };
}

// ---------------------------------------------------------------------------
// HTML generation — static asset data URIs
// ---------------------------------------------------------------------------

const ICON_ROTATE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAACdQTFRFAAAAFyMj/3tz/6uj/9vX/09D/wcA4wcAxwAAqwAAjwAAcwAA//PfHRUh3gAAAAF0Uk5TAEDm2GYAAADxSURBVHjazdNRTsMwEEXR+5y2CbD/nVKS0IwfGGFNqzZC/CDy59yjiRXZ4odHfwty6T0gCQEB3gGDhLfSjB+Bo+Tm6qUQfgBOwgjEJwnfgxGwAEGN8C4QwjW2ayCMxlxJLq8k0Lj6ZoLYjgnQeKn5xQkoLnOAeg+HoXN4osyHFdR7PJ8xCV6Yj5pBvVOmJToYpsU+lPIGovW6AUIwsUwL2Byk4dwnTOEApK8ImEE3oHpDpglbRm5gdW7SNUCWDE2QoI/wt6gy2fM/VHA0YbInaCOAZhigZQwJ0OkdRhug1bsj17aPYP/Q6votvwH/4G5+AEtIfyHh01/DAAAAAElFTkSuQmCC';
const ICON_ZOOM_IN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAEJQTFRFAAAAFyMj//uP//Nf///DP1NTW3Nzb4OD/+cvg5eXt8PD7/Pz88sbn6+v16cTv4sPp28Hj1MHXysAIzMzS2NjL0NDdDvM6gAAAAF0Uk5TAEDm2GYAAAD6SURBVHjazdJdT4MwGIbh5255yzq+hrD//wM90hg3HFDjTBYDOE882MVJE+6+TZPqAbBcp18Drp/mReJv/71z3oPCpC1kFqKZxWA7No7Ak4FOyj7y2Q9pY3/cF9GXO5NyK9GN09UMpDHqMkoD0iIAn3M5jd9r/FCxnMCbprw4yYqqrs8/R2S6QufoFJU5QLAMSCpAmuUQSusJqZzepdrNL3bRbtQSPuyrSNPU7GMMh/U1LfkpE8LI5oRW2FkVadsDVW4t3WYRIhCDtdBvFqWFPFhzgD4vuq33UDiJVz25l3xonrXGF0ldb8cO3cERenQPcPyHAv1R6FF8AhbJLhhGVO4aAAAAAElFTkSuQmCC';
const ICON_ZOOM_OUT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAD9QTFRFAAAAFyMj///D//uPS2Njb4ODg5eX//Nfn6+vt8PD09vb7/Pz/+cv88sb16cTv4sPp28Hdz8AL0NDW3NzP1NTB/dKQgAAAAF0Uk5TAEDm2GYAAADnSURBVHjazZLLTsMwFETnONdpHi2FtP//hWwQCNoo5JJEIUJOKBsWPbOxNKMjW7LuANKz/zpgivpkki09hBAQsd80QCBDrk/PWk8NU28WAF2tHxwpQ11UdVVqJLc9WgjLBPcPjbSs7gAhhrbTzK4r3zwxcFGf12HI/nC4/lTYt+hSomoIIEgHuCqQHI3xtcGL/l0T1mnXKYUszm9UVRTxuH6muVNOPfSOVrCz2VDm9kizuYgaiUPPaXOxt5hHezgOfV43W/+hRuJVT+HFuuOz1jAiqTnZuUE34AwndAvg/A8L9MdC98IX3CQsGlCT6RUAAAAASUVORK5CYII=';
const ICON_PREVIOUS = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAARpQTFRFAAAAi99zN58XW78/Uqw5Uao4Wbs+fcxn////6+zrY69PXsBCbMZTi9J37Ozsc7Rgc8hb4ePg5ubm/Pz84+Pj39/fUak4XbRGd71k/v7+9vf29fb1gM1q3uLd6erp7e3tcq9ha75UWr0/VK86fb9q9vb15ufmXaFKZcNKXL9BcbNe5+nmVaFAhc9w4+fi2traZ7RRbsZVWKlDhbh20NTPU6866OznYqtN6urqP4UsTJ80o9uT1dXVsbGxQ44vTaE1V7g9Y8JId8pfk9SB+vr6ycrJUZo85eblRHw0R5QxWLg9Y8JJhM9v+Pj3zc3Nubm5XqhI9/j2UIVBQootWLk9fMxlk9WBVLE68PDwkMSB7vLtablTR68nb89Xd3lGMgAAAAF0Uk5TAEDm2GYAAAEkSURBVHjardM/S8NgEMfx5xtSKUmL6OIfRAQR0UEDdpR2rZPi5uDbUwdBUEFEnESnKjgUNYMguigEnVK1JPV5EgfBe5qlWX7k8iEcxx2q4KEYgB2lpP+BeSWxAxdjvmygDF2lhkg6FlCFWCkfiCRQrvBhcgReexKYgDeTY8CTAGbgWYe1Sfc3p4FQAM7cY16d5U4a1CIvscl5+AwFsEw7678yzI046pX776z/8XZHiaCUVwJoJSJwa9em4i/wEIlAed28VnPgQgJ1uDS5ehtwrrPPoBrAqQSavI+emX94cCTvw1rpJMtgEg4k0PQ4NOlPVcNIXpjGVZ5qfV8G9daSnscGx3Hfpd1kT/0Bztau7SycngZqeye1AP1dYdJ+WYW3OQjwA+U4biEmzoW0AAAAAElFTkSuQmCC';
const ICON_NEXT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAARpQTFRFAAAAi99zN58XW78/Wbs+Uao4Uqw5Y69P6+zr////fcxnbMZTc7Rg7Ozsi9J3XsBCUak439/f4+Pj/Pz85ubm4ePgc8hb9fb19vf2/v7+d71kXbRGWr0/a75Ucq9h7e3t6erp3uLdgM1q9vb1fb9qVK86XL9BZcNKXaFK5ufmVaFA5+nmcbNebsZVZ7RR2tra4+fihc9wU6860NTPhbh2WKlDYqtN6OznTJ80P4Us6urqsbGx1dXVo9uTV7g9TaE1Q44vUZo8ycrJ+vr6k9SBd8pfY8JIWLg9R5QxRHw05eblXqhIubm5zc3N+Pj3hM9vY8JJWLk9QootUIVB9/j2k9WBfMxlVLE6kMSB8PDwablT7vLtR68nb89XrxDnFwAAAAF0Uk5TAEDm2GYAAAEeSURBVHjardMxSwNBEIbheWOCgSNFbESxSyF4giBXCIqVgqhYCWLh39NOxNhGOytj0Ea0CAqCGBAPPA8uJqdZN0Ugs7km0+wH+ywMywySUWQDcKOUdACYk+4IkMeIxAmK0BEpdPORDkpALOLBhw4myhCaUCaKNDADtEyYhhd3k6ZmoamCCvBsI4kGROZp9u1jqoLKJDyZ4M1xrwGRJcI4NMHnVgVS9N9b/x0v3KiAABo2tlVQ8nmITQjqiQJWoVO3sfAtClinsXxtJbVhsAFcjfqoLYjN+83PKarDYA/ebP87PxfqPCx+vcYm7NKuamD/XGytXTpGztvmTCS4W6k5gBxwqg9t7vDEtRa53x6Qo+PUAXr3gjndm5W5m+MAf+hrdiHa73zsAAAAAElFTkSuQmCC';
const FAVICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NDAgNjQwIj48c3R5bGU+LmZ7ZmlsbDojMzM4MDAwfUBtZWRpYShwcmVmZXJzLWNvbG9yLXNjaGVtZTpkYXJrKXsuZntmaWxsOiM5OUZGNTV9fTwvc3R5bGU+PHBhdGggb3BhY2l0eT0iLjQiIGQ9Ik02NCAyNzJDNjQgMjEwLjEgMTE0LjIgMTYwIDE3NiAxNjBMMTc2IDU0NEw2NCA1NDRMNjQgMjcyek0yMDggMTYzLjRDMjM3LjYgMTcwLjkgMjYzLjQgMTkwLjIgMjc4LjYgMjE3LjZMMzA0IDI2My4zTDMwNCA1NDRMMjA4IDU0NEwyMDggMTYzLjR6TTMzNiAzMjAuOUwzNzAuNCAzODIuN0MzODQuNCA0MDcuOSA0MDYuMyA0MjcuMiA0MzIgNDM4TDQzMiA1NDMuOUwzMzYgNTQzLjlMMzM2IDMyMC44ek00NjQgNDQ2LjhDNDY5LjcgNDQ3LjYgNDc1LjQgNDQ4IDQ4MS4yIDQ0OEM1MTguOSA0NDggNTUyLjggNDMxLjUgNTc2IDQwNS40TDU3NiA1NDRMNDY0IDU0NEw0NjQgNDQ2Ljh6IiBjbGFzcz0iZiIvPjxwYXRoIGQ9Ik0xNzYgMTYwQzExNC4yIDE2MCA2NCAyMTAuMSA2NCAyNzJMNjQgNTQ0TDMyIDU0NEwzMiAyNzJDMzIgMTkyLjUgOTYuNSAxMjggMTc2IDEyOEwxODAuNyAxMjhDMjMzIDEyOCAyODEuMiAxNTYuNCAzMDYuNiAyMDIuMUwzOTguNCAzNjcuM0M0MTUuMSAzOTcuNCA0NDYuOCA0MTYuMSA0ODEuMyA0MTYuMUM1OTYuNyA0MTYuMSA2MTEgMjQxLjggNDk2LjEgMjI1LjFMNDk2LjEgMzY1LjdDNDkxLjQgMzY3LjMgNDg2LjUgMzY4LjEgNDgxLjMgMzY4LjFDNDc1LjMgMzY4LjEgNDY5LjUgMzY3IDQ2NC4xIDM2NC44TDQ2NC4xIDIyNS45QzQ0Ny42IDIyOS4yIDQzMi4xIDIzNi45IDQxOS41IDI0OC40TDQwNi45IDI1OS45TDM4NS40IDIzNi4yTDM5OCAyMjQuN0M0MjEuMSAyMDMuNyA0NTEuMyAxOTIgNDgyLjUgMTkyQzU1MS45IDE5MiA2MDguMSAyNDguMiA2MDguMSAzMTcuNkw2MDguMSA1NDRMNTc2LjEgNTQ0TDU3Ni4xIDQwNS40QzU1Mi45IDQzMS41IDUxOSA0NDggNDgxLjMgNDQ4QzQ3NS41IDQ0OCA0NjkuOCA0NDcuNiA0NjQuMSA0NDYuOEw0NjQuMSA1NDRMNDMyLjEgNTQ0TDQzMi4xIDQzOC4xQzQwNi40IDQyNy4zIDM4NC41IDQwOCAzNzAuNSAzODIuOEwzMzYuMSAzMjFMMzM2LjEgNTQ0LjFMMzA0LjEgNTQ0LjFMMzA0LjEgMjYzLjRMMjc4LjcgMjE3LjdDMjYzLjUgMTkwLjMgMjM3LjcgMTcwLjkgMjA4LjEgMTYzLjVMMjA4LjEgNTQ0LjFMMTc2LjEgNTQ0LjFMMTc2LjEgMTYwLjF6IiBjbGFzcz0iZiIvPjwvc3ZnPgo=';
const FONT_RCT2 = 'data:font/woff2;base64,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';

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function generateHtml(manifest: TimelineManifest, domain?: string): string {
  const hasTimeline = manifest.timePoints.length > 1;
  const lastLabel = manifest.timePoints[manifest.timePoints.length - 1].label;
  const baseUrl = domain ? domain.replace(/\/$/, "") + "/" : undefined;
  const escLabel = lastLabel.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // Always show snapshot label; prev/next only when multiple snapshots

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

  // Parse URL hash state
  function parseHash() {
    var params = {};
    var hash = location.hash.replace(/^#/, '');
    if (!hash) return params;
    hash.split('&').forEach(function(part) {
      var kv = part.split('=');
      if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]);
    });
    return params;
  }

  var hashState = parseHash();
  var currentIdx = hashState.t !== undefined ? Math.min(Math.max(parseInt(hashState.t, 10), 0), CONFIG.timePoints.length - 1) : CONFIG.timePoints.length - 1;
  if (isNaN(currentIdx)) currentIdx = CONFIG.timePoints.length - 1;

  // Compute global bounds as union of all timepoint extents (each has its own scale)
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

  var initLat = hashState.lat !== undefined ? parseFloat(hashState.lat) : undefined;
  var initLng = hashState.lng !== undefined ? parseFloat(hashState.lng) : undefined;
  var initZoom = hashState.z !== undefined ? parseInt(hashState.z, 10) : undefined;

  var map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: maxZoom,
    zoomControl: false,
    attributionControl: false,
  });

  var initRot = hashState.r !== undefined ? parseInt(hashState.r, 10) : undefined;
  var currentRotation = (initRot !== undefined && CONFIG.rotations.indexOf(initRot) !== -1) ? initRot : CONFIG.rotations[0];
  var currentTimestamp = CONFIG.timePoints[currentIdx].timestamp;
  var labelEl = document.getElementById('snapshot-label');
  labelEl.textContent = CONFIG.timePoints[currentIdx].label;
  document.title = CONFIG.timePoints[currentIdx].label;

  // URL hash update (debounced)
  var hashTimeout;
  function updateHash() {
    clearTimeout(hashTimeout);
    hashTimeout = setTimeout(function() {
      var c = map.getCenter();
      var parts = [
        'z=' + map.getZoom(),
        'lat=' + c.lat.toFixed(2),
        'lng=' + c.lng.toFixed(2),
        'r=' + currentRotation,
        't=' + currentIdx
      ];
      history.replaceState(null, '', '#' + parts.join('&'));
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
        tileSize: CONFIG.tileSize || 256,
        noWrap: true,
        bounds: tpBounds,
      };
      if (tpMaxZoom < maxZoom) {
        opts.maxNativeZoom = tpMaxZoom;
      }
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
    map.removeLayer(tileLayers[currentRotation]);
    currentRotation = nextRot;
    tileLayers = getLayersForTimestamp(currentTimestamp);
    tileLayers[currentRotation].addTo(map);
    updateHash();
  }
  if (initLat !== undefined && initLng !== undefined && initZoom !== undefined && !isNaN(initLat) && !isNaN(initLng) && !isNaN(initZoom)) {
    map.setView(L.latLng(initLat, initLng), initZoom);
  } else {
    map.fitBounds(bounds);
  }
  map.setMaxBounds(bounds.pad(0.5));

  var ICON_ROTATE = '${ICON_ROTATE}';
  var ICON_ZOOM_IN = '${ICON_ZOOM_IN}';
  var ICON_ZOOM_OUT = '${ICON_ZOOM_OUT}';
  var ICON_PREVIOUS = '${ICON_PREVIOUS}';
  var ICON_NEXT = '${ICON_NEXT}';

  // Rotation control
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
  // Timeline prev/next control
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

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.target !== document.body) return;
    switch (e.key) {
      case 'r':
      case 'R':
        if (CONFIG.rotations.length > 1) rotateView();
        break;
      case 'ArrowLeft':
        if (typeof switchToTimepoint === 'function' && currentIdx > 0) {
          switchToTimepoint(currentIdx - 1);
        }
        break;
      case 'ArrowRight':
        if (typeof switchToTimepoint === 'function' && currentIdx < CONFIG.timePoints.length - 1) {
          switchToTimepoint(currentIdx + 1);
        }
        break;
    }
  });
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
  cleanupStaleArtifacts(outputDir);

  // Handle --list mode
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

  // Handle --rename mode
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
    fs.writeFileSync(path.join(outputDir, "index.html"), generateHtml(manifest, domain));
    console.error(`Renamed snapshot '${renameTimestamp}' to '${snapshotLabel}'.`);
    return;
  }

  // Handle --remove mode
  if (removeTimestamp) {
    removeSnapshot(outputDir, removeTimestamp, domain);
    return;
  }

  // Migrate legacy output (tiles/ at top level, no timeline.json)
  migrateLegacyOutput(outputDir, rotations);

  // Clear existing snapshots if requested
  if (clearSnapshots) {
    const snapshotsDir = path.join(outputDir, "snapshots");
    if (fs.existsSync(snapshotsDir)) {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
      console.error("Cleared existing snapshots.");
    }
    const manifestPath = path.join(outputDir, "timeline.json");
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  }

  // Read existing manifest or start fresh
  let manifest = readManifest(outputDir);
  const timestamp = makeTimestamp();
  const snapshotDir = path.join(outputDir, "snapshots", timestamp);
  fs.mkdirSync(snapshotDir, { recursive: true });

  // Generate screenshots
  console.error(`Generating screenshots (${ozRange.length > 1 ? `native zoom ${ozRange.join(",")}` : `zoom ${ozRange[0]}`})...`);
  const giantPngs: { rotation: number; zoom: number; path: string }[] = [];
  for (const rot of rotations) {
    for (const oz of ozRange) {
      const pngPath = await generateScreenshot(rot, oz);
      giantPngs.push({ rotation: rot, zoom: oz, path: pngPath });
    }
  }

  try {
    // Compare hash against previous snapshot
    const snapshotHash = computeSnapshotHash(giantPngs.map(g => g.path));
    if (!forceSnapshot && manifest && manifest.timePoints.length > 0) {
      const lastHash = manifest.timePoints[manifest.timePoints.length - 1].hash;
      if (lastHash && lastHash === snapshotHash) {
        console.error("\nMap unchanged since last snapshot — skipping. Use --force to save anyway.");
        fs.rmSync(snapshotDir, { recursive: true, force: true });
        return;
      }
    }

    // Generate tile pyramids into snapshot directory
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

    // Deduplicate tiles against the previous snapshot
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

    // Update manifest
    const existingPoints = manifest?.timePoints ?? [];
    const newPoint: TimePoint = {
      timestamp,
      label: snapshotLabel,
      hash: snapshotHash,
      maxZoom: Math.max(...metadataList.map(m => m.maxZoom)),
      imageWidth: Math.max(...metadataList.map(m => m.width)),
      imageHeight: Math.max(...metadataList.map(m => m.height)),
    };
    const allPoints = [...existingPoints, newPoint];
    const prevMaxZoom = manifest?.maxZoom ?? 0;
    const prevWidth = manifest?.imageWidth ?? 0;
    const prevHeight = manifest?.imageHeight ?? 0;
    manifest = {
      timePoints: allPoints,
      rotations,
      maxZoom: Math.max(...allPoints.map(tp => tp.maxZoom ?? prevMaxZoom)),
      imageWidth: Math.max(...allPoints.map(tp => tp.imageWidth ?? prevWidth)),
      imageHeight: Math.max(...allPoints.map(tp => tp.imageHeight ?? prevHeight)),
      tileSize,
    };
    writeManifest(outputDir, manifest);

    // Generate OG preview image only when --domain is set (crawlers need absolute URLs)
    if (domain) {
      // Use the finest zoom level at rotation 0 for best OG preview quality
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

    // Generate HTML viewer
    const htmlPath = path.join(outputDir, "index.html");
    fs.writeFileSync(htmlPath, generateHtml(manifest, domain));
    console.error(`Viewer written to ${htmlPath}`);
  } finally {
    // Clean up giant PNGs and temp config
    for (const { path: pngPath } of giantPngs) {
      try { fs.unlinkSync(pngPath); } catch {}
    }
    if (tmpConfigDir) fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  }

}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
