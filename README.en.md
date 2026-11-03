[简体中文](README.md) | **English**

# @huangxm168/ip-geo

IP geolocation that **uses [ip2region](https://github.com/lionsoul2014/ip2region) inside China and [MaxMind GeoLite](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) for the rest of the world**, with Hong Kong, Macau and Taiwan combining the two. Every lookup runs locally against data files; no online API is called.

```
114.114.114.114 → China · 江苏省 · 南京市                                   (ip2region)
203.80.96.10    → Hong Kong · 香港特别行政区 · 九龙湾 · 香港宽频             (ip2region + MaxMind)
210.196.3.183   → Japan · 东京都 · Azusawa · KDDI CORPORATION                (MaxMind)
```

Names are returned in Simplified Chinese where available (the package was built for Chinese-language sites); log messages and CLI output are in Chinese as well.

## Why two datasets

- ip2region is the most accurate source for mainland China (province, city, carrier), but outside China it only gives an English state name and usually no city; for Hong Kong / Macau / Taiwan it stops at the region level
- MaxMind GeoLite is the best free dataset outside China, but it is inaccurate inside China (in our tests it had no province or city for Nanjing's public DNS, and reported a US company as the carrier for an Alibaba address)
- So: **ip2region decides whether an IP is in China; mainland China comes from ip2region, the rest of the world from MaxMind, and Hong Kong / Macau / Taiwan combine both**. The full rules are in [docs/rules.md](docs/rules.md) (Chinese)

## Features

- **Never throws**: missing data, corrupt files and invalid input all degrade to a coarse or empty result
- **Hot reload without restarts**: when `geoipupdate` replaces a MaxMind file, the next check (hourly by default) loads the new file and **swaps it in only after it validates**; a bad file keeps the old data, a deleted file downgrades to fallback results
- **No timers, no file watchers**: the process can always exit (safe to import from build tools and one-off scripts)
- **Data versions recorded**: every result carries the versions of the data files it was derived from
- **ip2region versions ship with the package**: the package contains only a manifest (upstream commit + sha256); the data file is fetched against it, so updating the data means publishing a new version

## Install

```bash
npm install @huangxm168/ip-geo
```

Requires Node.js 22.12+. ESM only.

## Data

**ip2region** (required, ~11 MB):

```bash
npx ip-geo ip2region fetch --dir ./vendor/ip2region
```

Add `--cache-dir <long-lived dir>` in deployments and `--optional` for dev servers. See [docs/operations.md](docs/operations.md) (Chinese).

**MaxMind GeoLite** (optional; without it, Hong Kong / Macau / Taiwan and overseas IPs get ip2region's coarse result with `source: "ip2region-fallback"`, which can be re-resolved later): install MaxMind's official `geoipupdate` on the machine and have it download `GeoLite2-City` and `GeoLite2-ASN` into `/var/lib/GeoIP` on a schedule. Config and systemd timer templates are in [ops/](ops/). ⚠️ GeoLite data must **not** be committed to a repository or shipped with an application (GeoLite EULA).

## Usage

```ts
import { createGeoResolver } from "@huangxm168/ip-geo";

// One per process is enough (both datasets are held in memory, ~70 MB)
const geo = createGeoResolver({
  ip2regionDir: "./vendor/ip2region",
  maxmindDir: "/var/lib/GeoIP", // optional
  recheckIntervalMs: 60 * 60 * 1000, // default: 1 hour
  logger: myLogger, // optional, defaults to console; needs info / warn / error
});

const result = await geo.lookup("210.196.3.183");
// {
//   countryCode: "JP",
//   countryName: "日本",
//   region: "东京都",
//   city: "Azusawa",
//   isp: "KDDI CORPORATION",
//   source: "maxmind",
//   version: "ip2region@6a276cc7c4f9 GeoLite2@City-20261030+ASN-20261103",
// }

geo.status(); // current load state of both datasets, for health checks
```

### Result fields

| Field         | Meaning                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `countryCode` | ISO 3166-1 alpha-2; Hong Kong / Macau / Taiwan are always `HK` / `MO` / `TW`                                                                     |
| `countryName` | Simplified Chinese country name derived from the code, independent of the data source                                                            |
| `region`      | Province / state: full Chinese names inside China; elsewhere Simplified Chinese when available, otherwise English                                |
| `city`        | City, same as above                                                                                                                              |
| `isp`         | Carrier: ip2region inside China, the MaxMind ASN organization elsewhere                                                                          |
| `source`      | Where the location came from: `ip2region` / `ip2region+maxmind` / `maxmind` / `ip2region-fallback` / `none` (see [docs/rules.md](docs/rules.md)) |
| `version`     | Versions of the data files used, at most ~60 characters                                                                                          |

Private and reserved addresses, IPv6 and invalid input yield `source: "none"` with every other field `null`.

## CLI

```bash
ip-geo ip2region fetch --dir <dir> [--cache-dir <dir>] [--optional]
ip-geo doctor [--ip2region <dir>] [--maxmind <dir>] [--max-age-days 14] [--ip <address>]…
```

`doctor` checks that both datasets are present, which versions they are, and whether MaxMind is older than 14 days; with `--ip` it also runs lookups. It exits with 1 on errors.

## Data licenses and attribution

The code is MIT-licensed. The data has its own licenses; credit both on your site's privacy policy or analytics page:

- MaxMind GeoLite: [GeoLite EULA](https://www.maxmind.com/en/geolite2/eula). Attribution: "This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com". Internal use only, must not be used to identify or locate an individual, and old versions must be replaced within 30 days of a new release (the timer takes care of this)
- ip2region: [lionsoul2014/ip2region](https://github.com/lionsoul2014/ip2region), Apache-2.0 or MIT

## Limitations

- IPv6 is not resolved yet (always empty); see [docs/rules.md](docs/rules.md)
- MaxMind's Chinese names are incomplete, so overseas states and cities mix Chinese and English
- MaxMind restricts GeoLite City by account location; see [docs/operations.md](docs/operations.md)

## Development

```bash
npm install
npm test          # first run fetches the ip2region data into test/.data/
npm run lint
npm run typecheck
npm run check:pack
```

The MaxMind data used in tests is MaxMind's official test databases; see [test/fixtures/maxmind/README.md](test/fixtures/maxmind/README.md).

## License

[MIT](LICENSE)
