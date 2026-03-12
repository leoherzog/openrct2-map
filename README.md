# OpenRCT2 Map Generator

Generate a zoomable, pannable Leaflet tile map from any OpenRCT2 park save — like [Dynmap](https://github.com/webbukkit/dynmap) or [Unmined](https://unmined.net/) for Minecraft, but for RollerCoaster Tycoon 2.

[![OpenRCT2](https://img.shields.io/badge/OpenRCT2-338000?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAkVJREFUeNqdkV1Ik1EYxx81I7xJoxCpQOec364aNdzU1vJjalZ+lUtdr2STOa2JoRBrV5UEQWFlK6mjC5uKEN5EF4F33o5RrezGiHlhc0PKodty/7YXDAY1nD944HDO+f/geR6KhrpayVpUpxjthHDwbI8V9QYrGstLY5NcqFKw2u7XMGmG8XB6Hh1GK+oUsu1JmitPMlXXBEZMjXAIk+D7VonPo/ehMU1CJZdGlzRVlLGKzgmUm5zo7r2IwUIRNB3FGGqthmHajat3pqCUSiIk8VuHhlCfnsNaLpBaRomJcbS8+osW3Gs0b/fRksvH36VJKimveYArlRxhEYL60yXMfVDL+Q/wYb4ke70kF8ZT1xWOVO1qStod5O/TZdV0nLvJScWFjBecU8qZK03L+fbz4b+V5l+kgAukkBVTvrKG6jI8tC/Ry7/lKGpJqb/FHcvPZfHBICgujiLCe346KTXZScrFFQosq2mlX0vvZ2cIq9+3/oQyoM0giKdKfoKVd1pQe3cJ54e+QiO/hHfXE7BAhM0fIqCtCLNPR2B848DoJy8GzVMoys6O3Eh4ujX6V5A1GaBL2oW3vQn4wgtygJpDcFoYzPY13HgyiQKR6N/rLAlN90xDK67198FyzwBHjx6/Pe0IGsXYuD2AvkdW5GdlMYqGVFzA1G2XYX45DvvHD/AHfFjfWMf442HkCoWMtsPRvFzWUibFmE6HubkZWMZeICcz00axEO7zWUoKnj8QQyQQ2EQZgmSKlWyBgGWlZ9hC9d/wHzypBADY4Fw9AAAAAElFTkSuQmCC)](#)
[![Deno](https://img.shields.io/badge/Deno-000?logo=deno&logoColor=fff)](#)
[![Node.js](https://img.shields.io/badge/Node.js-6DA55F?logo=node.js&logoColor=white)](#)
[![Leaflet](https://img.shields.io/badge/Leaflet-199900?logo=leaflet&logoColor=white)](#)

## Requirements

| Requirement | Notes |
|---|---|
| **OpenRCT2** | Binary, AppImage, or system install. Auto-detected or pass `--openrct2 <path>` |
| **[RCT2 game assets](https://archive.org/details/OpenRCT2Assets)** | `Data/g1.dat` from a Steam/GOG install of the original RCT2 game, or placed in `./assets/RCT/` |
| **Deno 1.40+** or **Node.js >=18.17** | Deno is primary; Node works via `npx tsx` |

RCT1 data (`Data/csg1.dat`) is only required if your park uses RCT1 objects (rides, scenery, paths) or RCT1 scenarios.

## Usage

> [!IMPORTANT]
> Multiple runs will build up timeline history in the output directory. Only the deltas are saved between runs. This saves storage space, but means **you cannot simply remove a directory to clear snapshots without breaking symbolic links**. Use the `--remove` flag to clear unwanted snapshots from history, and the `--clear` flag to clear all snapshots and start fresh.

```bash
# Render a park and serve the result
deno run -A main.ts MyPark.park -o ./output
uv run python3 -m http.server -d ./output

# Build up a timeline — each run adds a snapshot
# (unchanged maps are skipped automatically)
deno run -A main.ts MyPark.park -o ./output --label "Week 1"
deno run -A main.ts MyPark.park -o ./output --label "Week 2"

# Force a snapshot even if the map hasn't changed
deno run -A main.ts MyPark.park -o ./output --force --label "Week 2 (copy)"

# Override screenshot flags (stormy weather, no guests)
deno run -A main.ts MyPark.park -o ./output -- --weather=3 --no-peeps

# List all snapshots
deno run -A main.ts --list -o ./output

# Rename a snapshot's label
deno run -A main.ts --rename 20260312-143022 --label "New label" -o ./output

# Remove a snapshot
deno run -A main.ts --remove 20260312-143022 -o ./output

# Clear all snapshots and start fresh
deno run -A main.ts MyPark.park -o ./output --clear

# Node alternative
npx tsx main.ts MyPark.park -o ./output
```

## `deno run main.ts --help`

```bash
$ deno run -A main.ts --help
Usage: main.ts <savefile> [options] [-- openrct2-flags...]

Options:
  -o, --output <dir>       Output directory (default: ./output)
  --zoom <n>               OpenRCT2 zoom level, 0 = closest (default: 1)
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
  -h, --help               Show this help

Screenshot defaults (applied unless you override that specific flag after --):
  --transparent, --tidy-up-park, --weather=1

Extra flags after -- are forwarded to openrct2 screenshot, e.g.:
  deno run -A main.ts park.park -o out -- --no-peeps
  deno run -A main.ts park.park -o out -- --weather=3  (overrides default sunny)

OpenRCT2 screenshot flags (pass after --):
    --weather=<int>           weather to be used (0 = default, 1 = sunny, ..., 6 = thunder).
    --no-peeps                hide peeps
    --no-sprites              hide all sprites (e.g. balloons, vehicles, guests)
    --clear-grass             set all grass to be clear of weeds
    --mowed-grass             set all grass to be mowed
    --water-plants            water plants for the screenshot
    --fix-vandalism           fix vandalism for the screenshot
    --remove-litter           remove litter for the screenshot
    --tidy-up-park            clear grass, water plants, fix vandalism and remove litter
    --transparent             make the background transparent
    --draw-bounding-boxes     draw bounding boxes
    --draw-segment-heights    draw segment heights
```

### License

Feel free to take a look at the source and adapt as you please. This source is licensed as follows:

[![Creative Commons License](https://i.creativecommons.org/l/by-sa/4.0/88x31.png)](http://creativecommons.org/licenses/by-sa/4.0/)

openrct-map is licensed under a [Creative Commons Attribution-ShareAlike 4.0 International License](http://creativecommons.org/licenses/by-sa/4.0/).

---

#### About Me

<a href="https://herzog.tech/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/link-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/link.svg.png">
    <img src="https://herzog.tech/signature/link.svg.png" width="32px">
  </picture>
</a>
<a href="https://mastodon.social/@herzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mastodon-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mastodon.svg.png">
    <img src="https://herzog.tech/signature/mastodon.svg.png" width="32px">
  </picture>
</a>
<a href="https://github.com/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/github-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/github.svg.png">
    <img src="https://herzog.tech/signature/github.svg.png" width="32px">
  </picture>
</a>
<a href="https://keybase.io/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/keybase-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/keybase.svg.png">
    <img src="https://herzog.tech/signature/keybase.svg.png" width="32px">
  </picture>
</a>
<a href="https://www.linkedin.com/in/leoherzog" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/linkedin-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/linkedin.svg.png">
    <img src="https://herzog.tech/signature/linkedin.svg.png" width="32px">
  </picture>
</a>
<a href="https://hope.edu/directory/people/herzog-leo/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/anchor-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/anchor.svg.png">
    <img src="https://herzog.tech/signature/anchor.svg.png" width="32px">
  </picture>
</a>
<br />
<a href="https://herzog.tech/$" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid-light.svg.png">
    <source media="(prefers-color-scheme: light)" srcset="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png">
    <img src="https://herzog.tech/signature/mug-tea-saucer-solid.svg.png" alt="Buy Me A Tea" width="32px">
  </picture>
  Found this helpful? Buy me a tea!
</a>
