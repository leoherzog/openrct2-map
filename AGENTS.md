# OpenRCT2 Map Viewer

Generates a Leaflet tile map viewer from OpenRCT2 park saves, like Dynmap or Pigmap for Minecraft.

## Architecture

`main.ts` is the whole tool. Node runs it directly with built-in type stripping, so there is no build step. Only erasable TypeScript works: no enums, namespaces or parameter properties, and type-only imports use `import type`. `npm run check` enforces this and type-checks with `tsc`.

**Pipeline:** CLI parse → screenshot (OpenRCT2) → tile (Sharp) → HTML

### Dependencies

- **Runtime:** Node.js 24+
- **npm:** `sharp` is the only runtime dependency; `typescript` and `@types/node` serve `npm run check`
- **External:** OpenRCT2
- **Browser:** Leaflet 1.x from jsDelivr, plus the `https://servers.openrct2.io/` master server list with `--status`

## OpenRCT2 CLI Quirks

### Screenshot command

```
openrct2 screenshot <file> <output.png> giant <zoom> <rotation> [flags]
```

- Zoom 0 is 1:1 pixels. The tool accepts 0-3.
- The tool passes `(r + 1) % 4` as `<rotation>`, so its rotation 0, in `--rotations`, snapshot directories and the URL's `r`, is OpenRCT2's rotation 1.
- `--weather=N`: 0 keeps the save's weather, 1 is sunny, 3 cloudy, 6 thunder.
- `openrct2 -ha` lists the screenshot flags; the `screenshot` subcommand rejects `-h` and `--help`. `node main.ts --help` appends that section from the detected binary, or omits it if the binary is missing or parsing fails.
- Each screenshot runs under `execFile` with a 10-minute timeout and the default 1 MB `maxBuffer`. OpenRCT2 warns once per conflicting scenario in the data path, and output past 1 MB fails the run with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.

### Global vs subcommand options

The `screenshot` subcommand has its own option parser, which rejects global options such as `--rct2-data-path`, `--rct1-data-path`, `--user-data-path` and `--headless` in either `--key=value` or `--key value` form. Before `screenshot` they fail with "All options must be passed at the end of the command line", and after the positional args with "Unknown option: --rct2-data-path".

### Config workaround via XDG_CONFIG_HOME (Linux only)

On Linux the tool writes a minimal config to `<tmpdir>/openrct2-map-XXXXXX/OpenRCT2/config.ini` and sets OpenRCT2's `XDG_CONFIG_HOME` to that temp directory:

```ini
[general]
game_path = "/absolute/path/to/assets/RCT"
rct1_path = "/absolute/path/to/assets/RCT"
```

- `game_path` is required, or OpenRCT2 fails with "Unable to load g1 graphics". Headless screenshot mode skips OpenRCT2's own Steam/GOG search, so it never falls back to an installed copy.
- `rct1_path` is optional, needed only for parks that use RCT1 objects or scenarios. Its `csg1.dat` must be the Loopy Landscapes version.
- Both name the parent of `Data/`, such as `assets/RCT`.

The tool never writes the user's own `~/.config/OpenRCT2/config.ini`. The override hides it from OpenRCT2, so discovery reads its `game_path` and `rct1_path` instead.

Only OpenRCT2's Linux build reads `XDG_CONFIG_HOME`. Windows reads `Documents\OpenRCT2\config.ini` and macOS `~/Library/Application Support/OpenRCT2/config.ini`, and the screenshot subcommand accepts no override. There the tool skips game data discovery and download, ignores `--rct2-data-path` and `--rct1-data-path`, and says so in one line. Unverified until run on Windows or macOS.

## Sharp Tiling

### Layout and format

`.tile({ layout: "google" })` writes `{z}/{y}/{x}.png`: row directories holding column files. The Leaflet URL template is therefore `{z}/{y}/{x}.png`, the reverse of the usual `{z}/{x}/{y}.png`.

Chain `.png()` before `.tile()`, or Sharp writes JPEG tiles. Tile output takes only the compression level from `.png()` and ignores `palette`, `effort` and the other quantization options, so `--palette` re-encodes every written tile in a second pass.

### Transparent tile skipping

`skipBlanks: n` skips a tile when every channel of every pixel is within n of the background, transparent black. OpenRCT2's `--transparent` pixels are exactly (0,0,0,0), so the default `--skip-blanks 0` drops the empty tiles around the isometric diamond, about half the grid. `-1` writes every tile. Leaflet renders the 404 for a skipped tile as empty.

### Tuning flags

- **`--palette`** writes indexed-color PNGs. It runs after tiling and before dedup: dedup compares final bytes, and rewriting a symlinked tile would change an older snapshot. At effort 4 and above, native zoom levels stay lossless because OpenRCT2 renders from a 256-color palette with binary alpha; downscaled levels are dithered.
- **`--effort`** implies `--palette`. Efforts 1-3 posterize the input, so native levels turn lossy and files grow. It does not affect zlib.

### Native zoom pyramid (default)

The tool renders OpenRCT2 zooms `--zoom` through 3 and merges them, so each Leaflet zoom shows RCT2's own sprites for that scale instead of downscaled tiles. Each OpenRCT2 zoom step halves the image, so consecutive renders tile to a `maxZoom` one apart on the same grid.

`assembleNativeTiles()` tiles the most zoomed-out render as the full pyramid. It tiles each closer render into a `.tmp-nz-*` directory and moves only that render's `maxZoom` level over the downscaled one. The finest render's size and `maxZoom` define the viewer's coordinates.

For `--zoom 1` this costs about 30% more screenshot and tiling time than `--single-zoom`, which renders only `--zoom` and lets Sharp downscale the lower levels, blurring them.

## Leaflet Coordinate System

### L.CRS.Simple bounds calculation

The viewer uses `L.CRS.Simple`. `latLng(0, 0)` is the image's top-left corner, and one CRS unit is `2^maxZoom` image pixels, so `pixel_y = -lat * 2^maxZoom`. Tile y=0 is the top row, as in Sharp's google layout, so `tms` stays off. Sharp pads each render to a power-of-two tile grid spanning `tileSize` CRS units per axis. The image fills only part of it, so each tile layer is bounded to its own image, from `[-imageHeight / 2^maxZoom, 0]` to `[0, imageWidth / 2^maxZoom]`.

Each timepoint stores its own `maxZoom`, `imageWidth` and `imageHeight`, so parks of different sizes can share an output directory. The map fits and clamps to the union of all timepoint bounds, and a layer with a lower `maxZoom` upscales through `maxNativeZoom`. Top-level values are maxima across timepoints and stand in for timepoints without their own.

## File Structure

```
openrct2-map/
  main.ts                    # The whole tool
  package.json, tsconfig.json
  example/                   # Committed render; .github/workflows/deploy-pages.yml publishes it on push
  OpenRCT2-*.AppImage        # Downloaded or user-provided binary (gitignored)
  assets/
    RCT/                     # RCT2 and RCT1 game data (gitignored)
    rotate.png, zoom-in.png, zoom-out.png, previous.png, next.png  # Viewer buttons
    rct2.otf, rct2.otf.woff2 # RCT2 bitmap font; the viewer uses the woff2
    roller-coaster-sharp-duotone-light-full.svg  # Favicon
    sprites.png              # RCT2 UI sprite sheet, source art
    openrct2-logo.svg, openrct2-logo-16px.png, screenshot.png  # README images
  test/                      # Local park files and run.sh, which renders example/ (gitignored)
```

`main.ts` holds the button PNGs and the woff2 font as base64 constants (`ICON_*`, `FONT_RCT2`) and reads only `assets/RCT` at runtime. After editing one of those files, re-encode it into `main.ts`. `FAVICON` is a hand-minified copy of the favicon SVG.

Generated output:
```
<output-dir>/
  index.html                 # Self-contained viewer; Leaflet from CDN
  og-image.png               # Only with --domain
  timeline.json              # Snapshot manifest
  snapshots/
    <timestamp>/             # One per run, e.g. 20260312-143022
      <rot>/<z>/<row>/<col>.png
      <rot>/blank.png        # Written by Sharp
      vips-properties.xml    # Written by Sharp
```

## Usage

`node main.ts --help` lists every flag. With explicit paths:

```bash
node main.ts <savefile> -o ./output \
  --openrct2 ./OpenRCT2-vX.X.X-linux-X.AppImage \
  --rct2-data-path ./assets/RCT \
  -- --weather=3 --no-peeps
uv run python3 -m http.server -d ./output
```

### Auto-discovery

Flags override each detected path. `findOpenRCT2()` tries `OpenRCT2-*.AppImage` or `OpenRCT2-*.exe` in cwd, newest version first, then the platform's well-known install paths, then on Windows extracted `OpenRCT2-*-windows-portable*` directories. Otherwise it returns the bare name `openrct2` for PATH lookup, which counts as nothing found.

Unless `--openrct2` is set, a render that found nothing or a copy in cwd calls `downloadPortableOpenRCT2()` after the save-hash early-out, so unchanged saves make no network calls. It never replaces a well-known install. It fetches the latest GitHub release: the AppImage on Linux x86_64, or the x64 or arm64 portable zip on Windows, extracted with PowerShell `Expand-Archive`. Releases ship no AppImage for other architectures, and macOS gets no download. A release already present under its file name is skipped. `download()` streams to `<dest>.tmp` and renames it into place only when complete. If anything fails, the render warns and uses what discovery found.

On Linux only, `findGameData()` tries `./assets/RCT`, then `game_path` or `rct1_path` from the user's own `$XDG_CONFIG_HOME/OpenRCT2/config.ini`, then Steam libraries under `~/.local/share/Steam` and `~/snap/steam/common/.local/share/Steam`. RCT2 data is found by `Data/g1.dat`, or `Assets/g1.dat` for RCT Classic; RCT1 data by `Data/csg1.dat`, or `Data/CSG1.DAT` as Steam ships it.

If no RCT2 data is found, `downloadGameAssets()` streams `archive.org/download/OpenRCT2Assets/RCT.zip` to `assets/RCT/RCT.zip`, which keeps it off tmpfs and out of git. It extracts the zip with the `unzip` command into `assets/`, since every entry sits under `RCT/`, then deletes it. Discovery then runs again, so RCT1 data in the archive is picked up too. `Data/g1.dat` is extracted last, so an interrupted extraction is not discovered and the next run downloads again.

### Screenshot defaults

`--transparent`, `--tidy-up-park` and `--weather=1` are added unless the flags after `--` already set them. Each default is replaced on its own: `--weather=3` replaces only the weather, and any flag that `--tidy-up-park` bundles (`--clear-grass`, `--water-plants`, `--fix-vandalism`, `--remove-litter`) drops `--tidy-up-park`.

## Timeline

### Cumulative snapshots

Each run appends a snapshot under `snapshots/<YYYYMMDD-HHmmss>/`, records it in `timeline.json` and regenerates `index.html`. The label defaults to `new Date().toLocaleString()`. `timeline.json` is written to a temp file and renamed into place, so a crash never leaves it truncated.

`rotations` and `tileSize` sit at the top of `timeline.json`, apply to every snapshot and are read by the viewer. A run whose `--rotations` set or `--tile-size` differs exits with an error before rendering; use the matching flags, `--clear` or a new output directory. `--clear` deletes the old snapshots and `timeline.json` only once the new screenshots exist.

### Change detection (two-tier)

**Save file hash:** a SHA-256 of the save file is compared with the last timepoint's `saveHash`. If they match, the run stops before game data discovery, downloads, OpenRCT2 or tiling. The hash covers only the save file, so changing `--zoom`, `--palette` or the flags after `--` on an unchanged save does nothing without `--force`.

**Screenshot hash:** after the screenshots and before tiling, a SHA-256 over all giant PNGs, sorted by path, is compared with the last timepoint's `hash`. This catches a changed save with identical visible output, such as guest movement under `--no-peeps`, and skips tiling.

`--force` bypasses both checks. A timepoint missing either field never matches.

### Symlink-based deduplication

After tiling, each tile byte-identical (`Buffer.equals`) to the same path in the previous snapshot becomes a relative symlink to the real file.

- Targets are resolved with `realpathSync`, so links never chain.
- Relative targets keep the output directory relocatable. The output directory itself is resolved with `realpathSync`, or targets would climb out through a symlink in the `-o` path.
- Each link is created under a temp name and renamed over the tile. Where symlinks fail, as on Windows without Administrator rights or Developer Mode, the tile stays a regular file.

### Snapshot removal (`--remove`)

`--remove <timestamp>` refuses to remove the only remaining snapshot. Otherwise:
1. The entry leaves `timeline.json`, the top-level `maxZoom`, `imageWidth` and `imageHeight` are recomputed, and `index.html` is regenerated.
2. Symlinks in other snapshots that resolve into the doomed directory are replaced with copies of their files.
3. The snapshot directory is deleted, if it still exists.

An interrupted removal leaves an orphaned snapshot, which the next render's cleanup finishes.

### Stale artifact cleanup

Each render starts with `cleanupStaleArtifacts()`, which deletes leftovers of crashed or killed runs. `--list`, `--rename` and `--remove` skip it. A render in progress has the same artifacts, so two renders must never share an output directory at once.

1. **Giant PNGs:** `giant_r*_z*.png` in the output directory
2. **Temp tile dirs:** `.tmp-nz-*` inside any snapshot, from native zoom assembly
3. **Orphaned snapshots:** directories under `snapshots/` missing from `timeline.json`, left by a crashed render or an interrupted `--remove`

Orphans are deleted with the same symlink materialization as `--remove`. That step is skipped when `timeline.json` is missing, since every snapshot would then look orphaned.

### Viewer

The current snapshot's label shows bottom-left in the RCT2 font and as the `<title>`. Previous/next buttons appear only with more than one snapshot, and the rotate button and `R` key work only with more than one rotation. Switching snapshots keeps the view and builds tile layers on first visit. `←`/`→` step through snapshots, and pan as usual at either end.

The URL hash, such as `#z=3&lat=-5.00&lng=4.00&r=0&t=1`, holds zoom, center, rotation and timepoint index, debounced through `history.replaceState`. Without a valid `z`, `lat` and `lng`, the map fits its bounds. An unknown `r` falls back to the first rendered rotation. A missing `t` means the latest snapshot, and an out-of-range `t` is clamped. `t` is an index, so shared links shift after `--remove`.

### Server status widget (`--status`)

`--status <name>` adds a top-right widget with a multiplayer server's online state and player count. The browser fetches `https://servers.openrct2.io/` every 60 seconds while the tab is visible. The request must send `Accept: application/json`, or the endpoint serves HTML. It allows any origin, so no backend is needed.

Matching ignores formatting codes like `{YELLOW}`, case and repeated whitespace. The list holds only servers with `advertise = true`, so an unadvertised server always shows Offline. A failed fetch, or one over 10 seconds, shows Unknown, not Offline.

Like `--domain`, the flag is not stored in `timeline.json`. Pass it to `--rename` and `--remove` too, or the regenerated viewer drops the widget.

### OpenGraph / social preview (`--domain`)

Crawlers do not run JavaScript, so `og:image` must be an absolute URL built from `--domain`. With it, the page adds `og:url`, `og:image` and `twitter:card`, and each render writes `og-image.png`: a center crop of the first rotation at the finest zoom, at most 1200x630. Renders of at least 2400x1260 are cropped at that size and halved with nearest-neighbour.
