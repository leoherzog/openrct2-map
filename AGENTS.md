# OpenRCT2 Map Viewer

Generates a Leaflet-based tile map viewer from OpenRCT2 park saves — similar to Dynmap/Pigmap for Minecraft.

## Architecture

Single-file tool: `main.ts` (~375 lines). No build step. Runs with `deno run -A main.ts` or Node (via tsx).

**Pipeline:** CLI parse → screenshot (openrct2) → tile (sharp) → HTML generation

### Dependencies

- **Runtime:** Deno (primary) or Node 18+
- **npm:** `sharp` (only dependency, mapped in `deno.json`)
- **External:** OpenRCT2 binary/AppImage (user-provided via `--openrct2`)
- **Browser CDN:** Leaflet 1.9.4 from unpkg (loaded by generated index.html)

## OpenRCT2 CLI Quirks

### Screenshot command

```
openrct2 screenshot <file> <output.png> giant <zoom> <rotation> [flags]
```

- Rotations: 0-3 (four 90-degree views)
- Zoom: 0 = closest (1:1 pixels), higher = more zoomed out. Default 1 is a good balance.
- Screenshot-specific flags: `--transparent`, `--tidy-up-park`, `--fix-vandalism`, `--remove-litter`, `--no-peeps`, `--no-sprites`, `--weather=N`, `--mowed-grass`, `--clear-grass`, `--water-plants`

### Global vs subcommand options

**The `screenshot` subcommand has its own option parser** that does NOT recognize global options like `--rct2-data-path`, `--rct1-data-path`, `--user-data-path`, or `--headless`. These cannot be passed on the command line at all with the screenshot subcommand:

- Placing them before `screenshot` → "All options must be passed at the end of the command line"
- Placing them after positional args → "Unknown option: --rct2-data-path"
- Both `--key=value` and `--key value` forms fail

### Config workaround via XDG_CONFIG_HOME

The solution is to create a temporary directory with a minimal `config.ini` and set `XDG_CONFIG_HOME` in the environment:

```
/tmp/openrct2-map-XXXXX/
  OpenRCT2/
    config.ini
```

Minimal `config.ini` for screenshots:
```ini
[general]
game_path = "/absolute/path/to/assets"
rct1_path = "/absolute/path/to/assets"
```

- `game_path` is **required** (directory containing `Data/g1.dat`). Without it: "Unable to load g1 graphics".
- `rct1_path` is **optional** (directory containing `Data/csg1.dat`). Only needed for RCT1 scenarios. The CSG1.DAT must be the Loopy Landscapes version specifically.
- Both paths point to the parent directory (e.g., `assets/RCT`), not to `assets/RCT/Data`.

This approach is self-contained: it doesn't touch `~/.config/OpenRCT2/config.ini`.

### execFile buffer limit

OpenRCT2 writes verbose scenario-conflict warnings to stdout. For parks with many scenarios in the data path, stdout can be large. The `execFile` default `maxBuffer` (1MB) is usually sufficient but could be increased if needed.

## Sharp Tiling

### Layout

`sharp.tile({ layout: 'google' })` generates a `z/row/col.png` directory structure. Sharp does NOT have a Leaflet-specific layout. Available layouts: `dz`, `google`, `zoomify`, `iiif`, `iiif3`.

### Axis swap

Sharp's google layout outputs `{z}/{row}/{col}.png` — rows are directories, columns are files. Leaflet's URL template uses `{z}/{x}/{y}` where x=column, y=row. **The Leaflet URL must be `{z}/{y}/{x}.png`** to compensate for the swap.

Verified empirically: a 2048x1536 image (8 cols, 6 rows) produces 6 directories (rows) each containing 8 files (cols).

### Transparent tile skipping

`skipBlanks: -1` skips fully transparent tiles. This saves significant space for isometric maps where the diamond shape leaves ~50% of the bounding rectangle empty.

### PNG format

Chain `.png()` before `.tile()` to ensure PNG output with alpha channel. Without it, tiles may default to JPEG.

## Leaflet Coordinate System

### L.CRS.Simple bounds calculation

Sharp's google layout pads the image to a power-of-2 tile grid. The full grid always spans 256 CRS units in each axis. The actual image occupies a fraction:

```js
var scale = Math.pow(2, maxZoom);
var bounds = L.latLngBounds(
  L.latLng(-imageHeight / scale, 0),  // southwest (bottom-left)
  L.latLng(0, imageWidth / scale)     // northeast (top-right)
);
```

- `L.CRS.Simple` transformation flips y: `pixel_y = -lat * scale`
- Tile y=0 is at the top (matching sharp's google layout), so `tms: true` is NOT needed
- `latlng(0, 0)` = top-left corner of the image

## File Structure

```
openrct2-map/
  deno.json                  # Config: nodeModulesDir, tasks, sharp import map
  main.ts                    # Single entry point (CLI, screenshots, tiling, HTML)
  AGENTS.md                  # This file
  OpenRCT2-*.AppImage        # User-provided binary (not committed)
  assets/RCT/                # Game data (not committed)
    Data/g1.dat, csg1.dat
    ObjData/, Scenarios/, Tracks/
  test/                      # Test park files (not committed)
```

Generated output:
```
<output-dir>/
  index.html                 # Self-contained viewer (inline CSS/JS, Leaflet from CDN)
  tiles/<rot>/<z>/<row>/<col>.png
```

## Usage

```bash
deno run -A main.ts <savefile> \
  --rct2-data-path ./assets/RCT \
  --openrct2 ./OpenRCT2-v0.4.32-linux-x86_64.AppImage \
  -o ./output \
  -- --transparent --tidy-up-park

# Optional flags
--rct1-data-path ./assets/RCT   # for RCT1 content
--zoom 1                         # OpenRCT2 zoom level (default: 1)
--rotations 0,1,2,3              # which rotations to render

# Serve result
python3 -m http.server -d ./output
```
