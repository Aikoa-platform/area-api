# OSM Area Server

A fast, self-contained server for querying suburb-level areas from OpenStreetMap data. Each area is stored with its postal code combinations, enabling queries like "find all instances of Lauttasaari" which returns both Lauttasaari 00200 and Lauttasaari 00210.

## Features

- **Self-contained**: Uses only OSM data, no external API dependencies
- **Area + Postal Code combinations**: Each unique (area, postal_code) pair is a separate row
- **Fast spatial queries**: R-tree indexes for sub-millisecond lookups
- **Multi-language names**: All OSM name translations included
- **Hierarchy resolution**: Parent city and municipality from admin boundaries
- **Easy country addition**: Simple CLI to ingest new countries

## Prerequisites

- [Bun](https://bun.sh) runtime
- [osmium-tool](https://osmcode.org/osmium-tool/) for filtering PBF files

```bash
# macOS
brew install osmium-tool

# Ubuntu/Debian
apt install osmium-tool

# Fedora
dnf install osmium-tool
```

## Installation

```bash
bun install
```

## Ingestion

Before running the server, you need to ingest OSM data for at least one country:

```bash
# Ingest Finland
bun run ingest:finland

# Or any supported country
bun run ingest -- --country sweden

# See all options
bun run ingest:help
```

The ingestion pipeline:

1. Downloads country extract from Geofabrik (~300MB for Finland)
2. Filters with osmium to ~1MB
3. Parses places, postal boundaries, and admin boundaries
4. Resolves hierarchy (parent city, country code)
5. Intersects areas with postal boundaries to create rows

## Running the Server

```bash
# Production
bun run start

# Development with hot reload
bun run dev
```

## API Endpoints

### GET /areas/nearby

Find areas within a radius of a point. Results are grouped by area by default, with all postal codes for each area collected into an array.

```bash
curl "http://localhost:3000/areas/nearby?lat=60.1699&lng=24.9384&radius=5000"
```

Parameters:

- `lat` (required): Latitude
- `lng` (required): Longitude
- `radius` (optional): Radius in meters (default: 5000, max: 100000)
- `limit` (optional): Max results (default: 50)
- `group` (optional): Group by area (default: true). Set to `false` to get individual (area, postal_code) rows.

Response (grouped):

```json
{
  "areas": [
    {
      "osm_id": 25238701,
      "osm_type": "node",
      "place_type": "suburb",
      "name": "Lauttasaari",
      "names": { "fi": "Lauttasaari", "sv": "Drumsö", "zh": "劳塔岛" },
      "postal_codes": ["00200", "00210"],
      "center": { "lat": 60.1603, "lng": 24.8852 },
      "parent_city": "Helsinki",
      "country_code": "FI",
      "distance_meters": 1523
    }
  ],
  "count": 1
}
```

### GET /areas/containing

Find areas whose polygon contains an exact point (reverse geocode to suburb).

```bash
curl "http://localhost:3000/areas/containing?lat=60.1834&lng=24.9500"
```

Parameters:

- `lat` (required): Latitude
- `lng` (required): Longitude
- `limit` (optional): Max results (default: 10)
- `group` (optional): Group by area (default: true)

### GET /areas/search

Search areas by name.

```bash
curl "http://localhost:3000/areas/search?q=kallio"
```

Parameters:

- `q` (required): Search query (min 2 characters)
- `limit` (optional): Max results (default: 20)
- `group` (optional): Group by area (default: true)

### GET /areas/adjacent

Find adjacent areas around a center. The center can be specified by search term or by coordinates. Each adjacent area includes direction (degrees and cardinal) and level (distance ring from center).

This endpoint is useful for building spatial UIs that show areas in relation to each other without a full map interface.

```bash
# By search term
curl "http://localhost:3000/areas/adjacent?q=lauttasaari"

# By coordinates
curl "http://localhost:3000/areas/adjacent?lat=60.1699&lng=24.9384"
```

Parameters:

- `q` (optional): Search query to find center area
- `lat` (optional): Latitude of center point
- `lng` (optional): Longitude of center point
- `radius` (optional): Search radius in meters (default: 5000, range: 100-100000)
- `limit` (optional): Max adjacent results (default: 20)

Note: Either `q` or both `lat`/`lng` are required.

Response:

```json
{
  "center": {
    "osm_id": 25238701,
    "osm_type": "node",
    "place_type": "suburb",
    "name": "Lauttasaari",
    "names": { "fi": "Lauttasaari", "sv": "Drumsö", "zh": "劳塔岛" },
    "postal_codes": ["00200", "00210"],
    "center": { "lat": 60.1598, "lng": 24.8802 },
    "parent_city": "Helsinki",
    "country_code": "FI",
    "distance_meters": 0
  },
  "adjacent": [
    {
      "osm_id": 3856536383,
      "osm_type": "node",
      "place_type": "quarter",
      "name": "Kotkavuori",
      "names": { "fi": "Kotkavuori", "sv": "Örnberget" },
      "postal_codes": ["00200", "00210"],
      "center": { "lat": 60.1628, "lng": 24.8835 },
      "parent_city": "Helsinki",
      "country_code": "FI",
      "distance_meters": 384,
      "degrees": 45,
      "direction": "NE",
      "level": 1
    },
    {
      "osm_id": 9991896507,
      "osm_type": "node",
      "place_type": "quarter",
      "name": "Myllykallio",
      "names": { "fi": "Myllykallio", "sv": "Kvarnberget" },
      "postal_codes": ["00200"],
      "center": { "lat": 60.1592, "lng": 24.8658 },
      "parent_city": "Helsinki",
      "country_code": "FI",
      "distance_meters": 796,
      "degrees": 270,
      "direction": "W",
      "level": 1
    }
  ],
  "count": 2
}
```

Direction fields:

- `degrees`: Direction from center in degrees (0=N, 45=NE, 90=E, 135=SE, 180=S, 225=SW, 270=W, 315=NW)
- `direction`: Cardinal direction string (N, NE, E, SE, S, SW, W, NW)
- `level`: Distance ring from center (1=immediately adjacent, 2=next ring, etc.). Within each direction, level 1 is the closest area, level 2 is the next closest, and so on.

### GET /stats

Get database statistics.

```bash
curl "http://localhost:3000/stats"
```

### GET /health

Health check endpoint.

```bash
curl "http://localhost:3000/health"
```

## Supported Countries

Run `bun run ingest -- --list` to see all supported countries. Currently includes:

- Nordic: Finland, Sweden, Norway, Denmark, Estonia
- Central Europe: Germany, France, Netherlands, Belgium, Austria, Switzerland, Poland
- Southern Europe: Spain, Portugal, Italy
- British Isles: United Kingdom, Ireland
- North America: United States, Canada, Mexico
- Asia: Japan, South Korea
- Oceania: Australia, New Zealand

## Environment Variables

- `API_KEY` (required): API key for authentication. Generate with `openssl rand -hex 32`
- `DB_PATH`: Path to SQLite database (default: `./db/areas.db`)
- `PORT`: Server port (default: `3000`)

See `.env.example` for a template.

## Authentication

All endpoints except `/health` require authentication via API key in production:

```bash
# Using X-API-Key header
curl -H "X-API-Key: your-api-key" "https://your-api.railway.app/areas/search?q=kallio"

# Using Authorization header
curl -H "Authorization: Bearer your-api-key" "https://your-api.railway.app/areas/search?q=kallio"
```

**Localhost:** When `API_KEY` is not set, authentication is disabled for localhost requests. This makes local development easier.

This API is designed for server-to-server use only. CORS is disabled.

## Project Structure

```
locations-server/
├── index.ts              # Bun.serve API server
├── db/
│   ├── schema.ts         # SQLite schema and types
│   ├── queries.ts        # Query functions
│   └── areas.db          # SQLite database (created by ingestion)
├── ingest/
│   ├── download.ts       # Geofabrik downloader
│   ├── parse.ts          # PBF parser and inserter
│   ├── hierarchy.ts      # Admin hierarchy resolution
│   ├── postal.ts         # Postal code intersection
│   └── run.ts            # CLI orchestrator
├── lib/
│   ├── geo.ts            # Geospatial utilities
│   └── osm-parser.ts     # OSM PBF streaming parser
└── data/                 # Downloaded PBF files
```

## Data Model

The final `areas` table stores each unique (area, postal_code) combination:

| Column              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| osm_id              | OpenStreetMap element ID                               |
| osm_type            | node, way, or relation                                 |
| place_type          | suburb, city_district, borough, neighbourhood, quarter |
| name                | Default/local name                                     |
| names               | JSON with all translations                             |
| center_lat/lng      | Center point coordinates                               |
| polygon             | GeoJSON polygon (nullable)                             |
| postal_code         | Postal code for this combination                       |
| country_code        | ISO 3166-1 alpha-2 code                                |
| parent_city         | Containing city/town name                              |
| parent_municipality | Containing municipality name                           |

## License

This project uses OpenStreetMap data, which is © OpenStreetMap contributors and available under the ODbL license.
