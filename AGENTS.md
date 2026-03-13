# OpenRCT2 Map Viewer

Generates a Leaflet-based tile map viewer from OpenRCT2 park saves — similar to Dynmap/Pigmap for Minecraft.

## Architecture

Single-file tool: `main.ts` (~1000 lines). No build step. Runs with `deno run -A main.ts` or Node (via tsx).

**Pipeline:** CLI parse → screenshot (openrct2) → tile (sharp) → HTML generation

### Dependencies

- **Runtime:** Deno (primary) or Node 18+
- **npm:** `sharp` (only dependency, mapped in `deno.json`)
- **External:** OpenRCT2 binary/AppImage (auto-detected in cwd or via `--openrct2`)
- **Browser CDN:** Leaflet 1.x from jsDelivr (loaded by generated index.html)

## OpenRCT2 CLI Quirks

### Screenshot command

```
openrct2 screenshot <file> <output.png> giant <zoom> <rotation> [flags]
```

- Rotations: 0-3 (four 90-degree views)
- Zoom: 0 = closest (1:1 pixels), higher = more zoomed out. Default 1 is a good balance.
- Screenshot-specific flags: `--transparent`, `--tidy-up-park`, `--fix-vandalism`, `--remove-litter`, `--no-peeps`, `--no-sprites`, `--weather=N`, `--mowed-grass`, `--clear-grass`, `--water-plants`, `--draw-bounding-boxes`, `--draw-segment-heights`
- Run `openrct2 -ha` to enumerate all screenshot flags (the `screenshot` subcommand rejects `-h`/`--help` directly)

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

### Performance tuning (CLI-exposed)

- **`--compression 0`** — biggest speed win. Skips zlib entirely; tiles are ~3-4x larger but tiling completes ~50% faster.
- **`--palette`** — indexed-color PNG. RCT2 sprites are inherently low-color, so this can shrink tiles 60-70% with minimal quality loss.
- **`--effort`** — controls zlib strategy (1-10). Lower values trade file size for speed. Only meaningful when compression > 0.
- **`--tile-size`** — stored in `timeline.json` as `tileSize` and read by the Leaflet viewer. Changing tile size on an existing output directory will cause a mismatch with older snapshots.
- **`--skip-blanks`** — `-1` means only fully transparent tiles are skipped. Higher values (0-255) set an alpha threshold below which tiles are considered blank.
- **`--concurrency`** — maps to `sharp.concurrency(n)`. Set to 1 on memory-constrained systems.

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
  assets/
    RCT/                     # Game data (not committed)
      Data/g1.dat, csg1.dat
      ObjData/, Scenarios/, Tracks/
    rotate.png               # UI icons (base64-embedded in generated HTML)
    zoom-in.png
    zoom-out.png
    previous.png             # Timeline step-back button
    next.png                 # Timeline step-forward button
    rct2.otf                 # RCT2 bitmap font
    rct2.otf.woff2           # RCT2 font (woff2, embedded in timeline UI)
    sprites.png              # RCT2 UI sprite sheet
  test/                      # Test park files (not committed)
```

Generated output:
```
<output-dir>/
  index.html                 # Self-contained viewer (inline CSS/JS, Leaflet from CDN)
  og-image.png               # OG preview image (only generated when --domain is set)
  timeline.json              # Manifest of all snapshots
  snapshots/
    <timestamp>/             # e.g. 20260312-143022
      <rot>/<z>/<row>/<col>.png
    <timestamp>/             # each run appends a new snapshot
      ...
```

## Usage

```bash
# Minimal — auto-detects everything, screenshot defaults applied
deno run -A main.ts <savefile> -o ./output

# Explicit overrides
deno run -A main.ts <savefile> \
  --openrct2 ./OpenRCT2-v0.4.32-linux-x86_64.AppImage \
  --rct2-data-path ./assets/RCT \
  --rct1-data-path ./assets/RCT \
  -o ./output \
  -- --weather=3 --no-peeps

# Other flags
--zoom 1                         # OpenRCT2 zoom level (default: 1)
--rotations 0,1,2,3              # which rotations to render
--label "March update"           # custom snapshot label (default: locale date/time)
--clear                          # clear all existing snapshots before generating
--force                          # save even if map is unchanged from last run
--tile-size 512                  # tile size in pixels (default: 256)
--compression 0                  # PNG compression 0-9 (default: 6, 0 = fastest)
--effort 1                       # PNG effort 1-10 (lower = faster)
--palette                        # indexed-color PNG (smaller for pixel art)
--skip-blanks 10                 # alpha threshold for blank tiles (default: -1)
--concurrency 2                  # libvips thread count (default: CPU cores)
--domain https://example.com/map # base URL for OG meta tags and og-image.png

# List all snapshots
deno run -A main.ts --list -o ./output

# Rename a snapshot's label
deno run -A main.ts --rename 20260312-143022 --label "New label" -o ./output

# Remove a snapshot
deno run -A main.ts --remove 20260312-143022 -o ./output

# Serve result
python3 -m http.server -d ./output
```

### Auto-discovery

All three paths (binary, RCT2 data, RCT1 data) are auto-detected. CLI flags override when provided.

**OpenRCT2 binary** (`findOpenRCT2()`, override: `--openrct2`):
1. cwd: `OpenRCT2-*.AppImage`, `OpenRCT2-*.exe` (newest version first)
2. Well-known paths: `C:\Program Files\OpenRCT2\openrct2.exe` (Windows), `/usr/bin/openrct2` (Linux), `/Applications/OpenRCT2.app/...` (macOS)
3. PATH fallback: `openrct2`

**RCT2 game data** (`findRCT2Data()`, override: `--rct2-data-path`), validated by `Data/g1.dat`:
1. `./assets/RCT` (local project setup)
2. Steam: `Rollercoaster Tycoon 2`, `RollerCoaster Tycoon Classic`
3. GOG (Windows): `C:\GOG Games\RollerCoaster Tycoon 2 Triple Thrill Pack`

**RCT1 game data** (`findRCT1Data()`, override: `--rct1-data-path`), validated by `Data/csg1.dat`:
1. `./assets/RCT` (same dir may contain both)
2. Steam: `RollerCoaster Tycoon Deluxe`
3. GOG (Windows): `C:\GOG Games\RollerCoaster Tycoon Deluxe`

Steam paths checked per platform:
- Linux: `~/.local/share/Steam/steamapps/common/...`, `~/snap/steam/common/.local/share/Steam/steamapps/common/...`
- Windows: `C:\Program Files (x86)\Steam\steamapps\common\...`
- macOS: `~/Library/Application Support/Steam/steamapps/common/...`

### Screenshot defaults

When no screenshot flags are passed after `--`, these defaults are applied:
- `--transparent` — transparent background (enables blank tile skipping)
- `--tidy-up-park` — clears grass, waters plants, fixes vandalism, removes litter
- `--weather=1` — forces sunny weather

Each default is independently overridden: passing `--weather=3` replaces the sunny default but keeps `--transparent` and `--tidy-up-park`. Passing any individual tidy flag (e.g. `--clear-grass`) suppresses `--tidy-up-park`.

### Screenshot flag enumeration

`--help` runs the detected binary with `-ha`, parses the screenshot section, and appends those flags to the help output. If the binary isn't found or parsing fails, help still works — the dynamic section is simply omitted.

## Timeline

### Cumulative snapshots

Each run appends a new timestamped snapshot to the output directory. The output directory is a persistent archive — `timeline.json` tracks all snapshots. The HTML viewer is regenerated each run.

Timestamp format: `YYYYMMDD-HHmmss` (filesystem-safe, sorts lexicographically).

Default label: `new Date().toLocaleString()`. Override with `--label`.

### Change detection

After generating screenshots but before tiling, a SHA-256 hash is computed over all giant PNGs (sorted by path). This hash is stored in `timeline.json` on each timepoint's `hash` field. On subsequent runs, the new hash is compared against the last timepoint's hash — if identical, the snapshot is skipped with a message. The `--force` flag bypasses this check. Snapshots created before this feature (no `hash` field) are never skipped.

### Symlink-based deduplication

After tiling a new snapshot, each tile is compared byte-for-byte (`Buffer.equals`) against the corresponding tile in the previous snapshot. Identical tiles are replaced with **relative symlinks** to the real file, keeping the output directory relocatable.

Key invariants:
- Symlinks always target real files (resolved via `realpathSync`), never other symlinks — no chains
- Relative targets ensure the output dir can be moved or served from any location
- Dedup stats are logged: `N/M tiles symlinked (X% saved)`

### Snapshot removal (`--remove`)

`--remove <timestamp>` safely removes a snapshot:
1. All symlinks in other snapshots that resolve into the doomed directory are **materialized** (replaced with copies of the real file content)
2. The snapshot directory is deleted
3. `timeline.json` is updated and `index.html` regenerated

This ensures no dangling symlinks after removal.

### Legacy migration

If the output directory contains `tiles/` but no `timeline.json` (pre-timeline format), the tool auto-migrates: `tiles/` is moved to `snapshots/migrated/` and a single-entry manifest is created.

### Timeline viewer

When multiple snapshots exist, the HTML viewer shows timeline controls (top-left):
- **Previous/Next buttons** — `previous.png`/`next.png` (RCT2-style pixel art)
- **Label** — current snapshot label displayed in RCT2 font (`rct2.otf.woff2`), bottom-left corner
- **`<title>`** — set to the current snapshot's label, updated dynamically when switching
- Map position and zoom are preserved when switching timepoints
- Tile layers are created lazily (only when a timepoint is first visited)

Single-snapshot output has no prev/next buttons — identical to original behavior.

### URL hash state

The viewer persists map state in the URL hash fragment (`#z=3&lat=-5.00&lng=4.00&r=0&t=1`), enabling shareable links to a specific view. Parameters: `z` (zoom), `lat`/`lng` (center), `r` (rotation), `t` (timepoint index). On load, these override defaults; on interaction, the hash is updated via `history.replaceState` (debounced 150ms). Missing or invalid parameters fall back to defaults (fit bounds, rotation 0, latest timepoint).

### Rotation button

The rotate button is hidden when `CONFIG.rotations` has only one entry (e.g. `--rotations 0`). Since rotations are per-output-directory (stored in `timeline.json`), this applies to all snapshots in the timeline.

### OpenGraph / social preview (`--domain`)

Social media crawlers (Facebook, Twitter/X, Discord, Slack, iMessage) do **not** execute JavaScript — they parse raw HTML only. This means `og:image` must use an absolute URL to work.

The `--domain <url>` flag controls OG tag generation:

- **Without `--domain`:** Only basic meta tags are emitted (`og:type`, `og:title`, `og:description`). No `og:image`, `og:url`, `twitter:card`, or `<base>` tag. No `og-image.png` is generated. This avoids emitting broken relative URLs.
- **With `--domain`:** The generated HTML includes `<base href>`, `<meta property="og:url">`, `<meta property="og:image">` (absolute URL), and `<meta name="twitter:card">`. An `og-image.png` (1200x630, cropped from center of first rotation) is generated in the output directory.
