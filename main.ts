import { parseArgs } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import sharp from "sharp";

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o", default: "./output" },
    zoom: { type: "string", default: "1" },
    rotations: { type: "string", default: "0,1,2,3" },
    openrct2: { type: "string", default: "openrct2" },
    "rct1-data-path": { type: "string" },
    "rct2-data-path": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  // Everything after -- is collected in positionals (extra flags for openrct2)
  strict: false,
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: openrct2-map <savefile> [options] [-- openrct2-flags...]

Options:
  -o, --output <dir>       Output directory (default: ./output)
  --zoom <n>               OpenRCT2 zoom level, 0 = closest (default: 1)
  --rotations <list>       Comma-separated rotations to render (default: 0,1,2,3)
  --openrct2 <path>        Path to openrct2 binary/AppImage (default: openrct2)
  --rct2-data-path <path>  Path to RCT2 data dir (containing Data/g1.dat) [required]
  --rct1-data-path <path>  Path to RCT1 data dir (containing Data/csg1.dat) [optional]
  -h, --help               Show this help

Extra flags after -- are forwarded to openrct2 screenshot, e.g.:
  deno run -A main.ts park.park --rct2-data-path ./assets/RCT -o out -- --transparent --tidy-up-park`);
  process.exit(0);
}

const inputFile = path.resolve(positionals[0]);
const outputDir = path.resolve(values.output as string);
const zoomLevel = parseInt(values.zoom as string, 10);
const rotations = (values.rotations as string).split(",").map(Number);
const openrct2Bin = values.openrct2 as string;
const rct1DataPath = values["rct1-data-path"] as string | undefined;
const rct2DataPath = values["rct2-data-path"] as string | undefined;

// Extra flags after -- are screenshot-specific (e.g. --transparent, --tidy-up-park)
const extraFlags = positionals.slice(1);

if (!rct2DataPath) {
  console.error("Error: --rct2-data-path is required (directory containing Data/g1.dat)");
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Error: input file not found: ${inputFile}`);
  process.exit(1);
}

// Create a temporary XDG_CONFIG_HOME with a config.ini so OpenRCT2 finds the
// game assets without touching the user's real config.
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrct2-map-"));
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

const screenshotEnv = { ...process.env, XDG_CONFIG_HOME: tmpConfigDir };

// ---------------------------------------------------------------------------
// Screenshot generation
// ---------------------------------------------------------------------------

async function generateScreenshot(
  rotation: number,
): Promise<string> {
  const outPng = path.join(outputDir, `giant_r${rotation}.png`);
  const args = [
    "screenshot",
    inputFile,
    outPng,
    "giant",
    String(zoomLevel),
    String(rotation),
    ...extraFlags,
  ];

  const idx = rotations.indexOf(rotation) + 1;
  console.error(`[${idx}/${rotations.length}] openrct2 ${args.join(" ")}`);

  try {
    await execFile(openrct2Bin, args, { timeout: 600_000, env: screenshotEnv });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.error(
        `Error: '${openrct2Bin}' not found. Install OpenRCT2 or use --openrct2 <path>.`,
      );
      process.exit(1);
    }
    throw err;
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
  tileDir: string;
}

async function generateTiles(
  giantPng: string,
  rotation: number,
): Promise<TileMetadata> {
  const meta = await sharp(giantPng).metadata();
  const width = meta.width!;
  const height = meta.height!;

  const tileDir = path.join(outputDir, "tiles", String(rotation));

  console.error(
    `  Tiling rotation ${rotation}: ${width}x${height}px → ${tileDir}`,
  );

  await sharp(giantPng)
    .png()
    .tile({
      size: 256,
      layout: "google",
      overlap: 0,
      skipBlanks: -1,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toFile(tileDir);

  // Determine maxZoom from the generated directory structure
  const zoomDirs = fs.readdirSync(tileDir)
    .filter((d) => /^\d+$/.test(d))
    .map(Number);
  const maxZoom = Math.max(...zoomDirs);

  return { rotation, width, height, maxZoom, tileDir };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function generateHtml(metadataList: TileMetadata[]): string {
  const config = {
    rotations: metadataList.map((m) => m.rotation),
    maxZoom: metadataList[0].maxZoom,
    imageWidth: metadataList[0].width,
    imageHeight: metadataList[0].height,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenRCT2 Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #map { width: 100%; height: 100vh; background: #0d0d0d; }

  .rct2-control {
    display: flex;
    overflow: hidden;
  }
  .rct2-control.vertical { flex-direction: column; gap: 2px; }
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
  .rct2-btn img { width: 32px; height: 32px; image-rendering: pixelated; }
</style>
</head>
<body>
<div id="map"></div>
<script>
(function() {
  var CONFIG = ${JSON.stringify(config)};
  var maxZoom = CONFIG.maxZoom;

  // L.CRS.Simple: latlng(y, x), y increases upward. Transformation flips y.
  // sharp google layout: zoom 0 = 1 tile, zoom N = 2^N x 2^N tiles, y=0 at top.
  // Image bounds in CRS.Simple units: the full tile grid spans 256 units in each axis
  // (because at zoom 0 there is one 256px tile = 256 units). The actual image occupies
  // a fraction of that grid: w / (2^maxZoom * 256) * 256 = w / 2^maxZoom units wide.
  var scale = Math.pow(2, maxZoom);
  var bounds = L.latLngBounds(
    L.latLng(-CONFIG.imageHeight / scale, 0),
    L.latLng(0, CONFIG.imageWidth / scale)
  );

  var map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: maxZoom,
    zoomControl: false,
    attributionControl: false,
  });

  var currentRotation = CONFIG.rotations[0];
  var tileLayers = {};

  CONFIG.rotations.forEach(function(rot) {
    // sharp google layout outputs z/row/col — swap x,y for Leaflet's z/col/row
    tileLayers[rot] = L.tileLayer('tiles/' + rot + '/{z}/{y}/{x}.png', {
      minZoom: 0,
      maxZoom: maxZoom,
      tileSize: 256,
      noWrap: true,
      bounds: bounds,
    });
  });

  tileLayers[currentRotation].addTo(map);
  map.fitBounds(bounds);
  map.setMaxBounds(bounds.pad(0.5));

  var ICON_ROTATE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAACdQTFRFAAAAFyMj/3tz/6uj/9vX/09D/wcA4wcAxwAAqwAAjwAAcwAA//PfHRUh3gAAAAF0Uk5TAEDm2GYAAADxSURBVHjazdNRTsMwEEXR+5y2CbD/nVKS0IwfGGFNqzZC/CDy59yjiRXZ4odHfwty6T0gCQEB3gGDhLfSjB+Bo+Tm6qUQfgBOwgjEJwnfgxGwAEGN8C4QwjW2ayCMxlxJLq8k0Lj6ZoLYjgnQeKn5xQkoLnOAeg+HoXN4osyHFdR7PJ8xCV6Yj5pBvVOmJToYpsU+lPIGovW6AUIwsUwL2Byk4dwnTOEApK8ImEE3oHpDpglbRm5gdW7SNUCWDE2QoI/wt6gy2fM/VHA0YbInaCOAZhigZQwJ0OkdRhug1bsj17aPYP/Q6votvwH/4G5+AEtIfyHh01/DAAAAAElFTkSuQmCC';
  var ICON_ZOOM_IN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAEJQTFRFAAAAFyMj//uP//Nf///DP1NTW3Nzb4OD/+cvg5eXt8PD7/Pz88sbn6+v16cTv4sPp28Hj1MHXysAIzMzS2NjL0NDdDvM6gAAAAF0Uk5TAEDm2GYAAAD6SURBVHjazdJdT4MwGIbh5255yzq+hrD//wM90hg3HFDjTBYDOE882MVJE+6+TZPqAbBcp18Drp/mReJv/71z3oPCpC1kFqKZxWA7No7Ak4FOyj7y2Q9pY3/cF9GXO5NyK9GN09UMpDHqMkoD0iIAn3M5jd9r/FCxnMCbprw4yYqqrs8/R2S6QufoFJU5QLAMSCpAmuUQSusJqZzepdrNL3bRbtQSPuyrSNPU7GMMh/U1LfkpE8LI5oRW2FkVadsDVW4t3WYRIhCDtdBvFqWFPFhzgD4vuq33UDiJVz25l3xonrXGF0ldb8cO3cERenQPcPyHAv1R6FF8AhbJLhhGVO4aAAAAAElFTkSuQmCC';
  var ICON_ZOOM_OUT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAD9QTFRFAAAAFyMj///D//uPS2Njb4ODg5eX//Nfn6+vt8PD09vb7/Pz/+cv88sb16cTv4sPp28Hdz8AL0NDW3NzP1NTB/dKQgAAAAF0Uk5TAEDm2GYAAADnSURBVHjazZLLTsMwFETnONdpHi2FtP//hWwQCNoo5JJEIUJOKBsWPbOxNKMjW7LuANKz/zpgivpkki09hBAQsd80QCBDrk/PWk8NU28WAF2tHxwpQ11UdVVqJLc9WgjLBPcPjbSs7gAhhrbTzK4r3zwxcFGf12HI/nC4/lTYt+hSomoIIEgHuCqQHI3xtcGL/l0T1mnXKYUszm9UVRTxuH6muVNOPfSOVrCz2VDm9kizuYgaiUPPaXOxt5hHezgOfV43W/+hRuJVT+HFuuOz1jAiqTnZuUE34AwndAvg/A8L9MdC98IX3CQsGlCT6RUAAAAASUVORK5CYII=';

  // Rotation control: single button that cycles through rotations
  var RotationControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      var container = L.DomUtil.create('div', 'rct2-control leaflet-bar');
      L.DomEvent.disableClickPropagation(container);
      var btn = L.DomUtil.create('button', 'rct2-btn', container);
      btn.innerHTML = '<img src="' + ICON_ROTATE + '" alt="Rotate">';
      btn.title = 'Rotate view';
      L.DomEvent.on(btn, 'click', function() {
        var idx = CONFIG.rotations.indexOf(currentRotation);
        var nextIdx = (idx + 1) % CONFIG.rotations.length;
        var nextRot = CONFIG.rotations[nextIdx];
        map.removeLayer(tileLayers[currentRotation]);
        currentRotation = nextRot;
        tileLayers[currentRotation].addTo(map);
      });
      return container;
    },
  });

  // Zoom control
  var ZoomControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      var container = L.DomUtil.create('div', 'rct2-control vertical leaflet-bar');
      L.DomEvent.disableClickPropagation(container);
      var zoomIn = L.DomUtil.create('button', 'rct2-btn', container);
      zoomIn.innerHTML = '<img src="' + ICON_ZOOM_IN + '" alt="Zoom in">';
      zoomIn.title = 'Zoom in';
      L.DomEvent.on(zoomIn, 'click', function() { map.zoomIn(); });
      var zoomOut = L.DomUtil.create('button', 'rct2-btn', container);
      zoomOut.innerHTML = '<img src="' + ICON_ZOOM_OUT + '" alt="Zoom out">';
      zoomOut.title = 'Zoom out';
      L.DomEvent.on(zoomOut, 'click', function() { map.zoomOut(); });
      return container;
    },
  });

  new RotationControl().addTo(map);
  new ZoomControl().addTo(map);
})();
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  // Generate screenshots
  console.error("Generating screenshots...");
  const giantPngs: { rotation: number; path: string }[] = [];
  for (const rot of rotations) {
    const pngPath = await generateScreenshot(rot);
    giantPngs.push({ rotation: rot, path: pngPath });
  }

  // Generate tile pyramids
  console.error("\nGenerating tile pyramids...");
  const metadataList: TileMetadata[] = [];
  for (const { rotation, path: pngPath } of giantPngs) {
    const meta = await generateTiles(pngPath, rotation);
    metadataList.push(meta);
    console.error(
      `  → rotation ${rotation}: ${meta.maxZoom + 1} zoom levels`,
    );
  }

  // Generate HTML viewer
  const htmlPath = path.join(outputDir, "index.html");
  fs.writeFileSync(htmlPath, generateHtml(metadataList));
  console.error(`\nViewer written to ${htmlPath}`);

  // Clean up giant PNGs and temp config
  for (const { path: pngPath } of giantPngs) {
    fs.unlinkSync(pngPath);
  }
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });

  console.error("Done! Serve the output directory with any static file server:");
  console.error(`  python3 -m http.server -d ${outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
