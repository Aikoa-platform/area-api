/**
 * Download country OSM extracts from Geofabrik and filter with osmium.
 */

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Geofabrik download URLs for countries
// See: https://download.geofabrik.de/
const GEOFABRIK_URLS: Record<string, string> = {
  // Europe
  finland: "https://download.geofabrik.de/europe/finland-latest.osm.pbf",
  sweden: "https://download.geofabrik.de/europe/sweden-latest.osm.pbf",
  norway: "https://download.geofabrik.de/europe/norway-latest.osm.pbf",
  denmark: "https://download.geofabrik.de/europe/denmark-latest.osm.pbf",
  estonia: "https://download.geofabrik.de/europe/estonia-latest.osm.pbf",
  germany: "https://download.geofabrik.de/europe/germany-latest.osm.pbf",
  france: "https://download.geofabrik.de/europe/france-latest.osm.pbf",
  netherlands:
    "https://download.geofabrik.de/europe/netherlands-latest.osm.pbf",
  belgium: "https://download.geofabrik.de/europe/belgium-latest.osm.pbf",
  austria: "https://download.geofabrik.de/europe/austria-latest.osm.pbf",
  switzerland:
    "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf",
  poland: "https://download.geofabrik.de/europe/poland-latest.osm.pbf",
  spain: "https://download.geofabrik.de/europe/spain-latest.osm.pbf",
  portugal: "https://download.geofabrik.de/europe/portugal-latest.osm.pbf",
  italy: "https://download.geofabrik.de/europe/italy-latest.osm.pbf",
  "united-kingdom":
    "https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf",
  ireland:
    "https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf",

  // North America
  "united-states":
    "https://download.geofabrik.de/north-america/us-latest.osm.pbf",
  canada: "https://download.geofabrik.de/north-america/canada-latest.osm.pbf",
  mexico: "https://download.geofabrik.de/north-america/mexico-latest.osm.pbf",

  // Asia
  japan: "https://download.geofabrik.de/asia/japan-latest.osm.pbf",
  "south-korea":
    "https://download.geofabrik.de/asia/south-korea-latest.osm.pbf",

  // Oceania
  australia:
    "https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf",
  "new-zealand":
    "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf",
};

// Country code mapping
const COUNTRY_CODES: Record<string, string> = {
  finland: "FI",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  estonia: "EE",
  germany: "DE",
  france: "FR",
  netherlands: "NL",
  belgium: "BE",
  austria: "AT",
  switzerland: "CH",
  poland: "PL",
  spain: "ES",
  portugal: "PT",
  italy: "IT",
  "united-kingdom": "GB",
  ireland: "IE",
  "united-states": "US",
  canada: "CA",
  mexico: "MX",
  japan: "JP",
  "south-korea": "KR",
  australia: "AU",
  "new-zealand": "NZ",
};

// Default English country names (can be overridden via --country-name)
const COUNTRY_NAMES: Record<string, string> = {
  finland: "Finland",
  sweden: "Sweden",
  norway: "Norway",
  denmark: "Denmark",
  estonia: "Estonia",
  germany: "Germany",
  france: "France",
  netherlands: "Netherlands",
  belgium: "Belgium",
  austria: "Austria",
  switzerland: "Switzerland",
  poland: "Poland",
  spain: "Spain",
  portugal: "Portugal",
  italy: "Italy",
  "united-kingdom": "United Kingdom",
  ireland: "Ireland",
  "united-states": "United States",
  canada: "Canada",
  mexico: "Mexico",
  japan: "Japan",
  "south-korea": "South Korea",
  australia: "Australia",
  "new-zealand": "New Zealand",
};

export function getCountryCode(country: string): string {
  const code = COUNTRY_CODES[country.toLowerCase()];
  if (!code) {
    const derived = country.toUpperCase().slice(0, 2);
    console.warn(
      `  Warning: Unknown country '${country}', using derived code '${derived}'`
    );
    return derived;
  }
  return code;
}

export function getCountryName(country: string): string {
  const lower = country.toLowerCase();
  const name = COUNTRY_NAMES[lower];
  if (name) {
    return name;
  }
  // Capitalize first letter of each word as fallback
  const derived = country
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  console.warn(
    `  Warning: Unknown country '${country}', using derived name '${derived}'`
  );
  return derived;
}

export function getSupportedCountries(): string[] {
  return Object.keys(GEOFABRIK_URLS);
}

export interface DownloadOptions {
  dataDir: string;
  country: string;
  countryName?: string; // Override the default English country name
  skipDownload?: boolean;
  skipFilter?: boolean;
}

export interface DownloadResult {
  rawPbfPath: string;
  filteredPbfPath: string;
  countryCode: string;
  countryName: string;
}

/**
 * Download a country's OSM extract from Geofabrik.
 */
export async function downloadCountry(
  options: DownloadOptions
): Promise<DownloadResult> {
  const { dataDir, country, countryName, skipDownload, skipFilter } = options;
  const countryLower = country.toLowerCase();

  const url = GEOFABRIK_URLS[countryLower];
  if (!url) {
    throw new Error(
      `Unknown country: ${country}. Supported: ${Object.keys(
        GEOFABRIK_URLS
      ).join(", ")}`
    );
  }

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const rawPbfPath = join(dataDir, `${countryLower}-latest.osm.pbf`);
  const filteredPbfPath = join(dataDir, `${countryLower}-filtered.osm.pbf`);

  // Download if needed
  if (!skipDownload && !existsSync(rawPbfPath)) {
    console.log(`Downloading ${country} from Geofabrik...`);
    console.log(`  URL: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download: ${response.status} ${response.statusText}`
      );
    }

    const buffer = await response.arrayBuffer();
    await Bun.write(rawPbfPath, buffer);
    console.log(`  Downloaded to ${rawPbfPath}`);
  } else if (existsSync(rawPbfPath)) {
    console.log(`Using existing PBF: ${rawPbfPath}`);
  }

  // Filter with osmium
  if (!skipFilter) {
    await filterWithOsmium(rawPbfPath, filteredPbfPath);
  }

  return {
    rawPbfPath,
    filteredPbfPath,
    countryCode: getCountryCode(countryLower),
    countryName: countryName || getCountryName(countryLower),
  };
}

/**
 * Filter PBF file with osmium to extract only relevant data.
 */
async function filterWithOsmium(
  inputPath: string,
  outputPath: string
): Promise<void> {
  console.log("Filtering with osmium...");

  // Check if osmium is available
  try {
    await $`which osmium`.quiet();
  } catch {
    throw new Error(
      "osmium-tool not found. Please install it:\n" +
        "  macOS: brew install osmium-tool\n" +
        "  Ubuntu: apt install osmium-tool\n" +
        "  Fedora: dnf install osmium-tool"
    );
  }

  // Filter command extracts:
  // - place=suburb,city_district,borough,neighbourhood,quarter (the areas we want)
  // - boundary=postal_code (for postal code polygons, if available)
  // - boundary=administrative (for hierarchy and country codes)
  // - place=city,town,municipality,village (parent cities)
  // - addr:postcode (for sampling postal codes from address nodes)
  //
  // We use a two-step process to ensure polygon geometries are complete:
  // 1. Filter for elements with matching tags
  // 2. Use getid -r to extract those elements with all referenced nodes/ways
  //    (osmium tags-filter -R doesn't properly include nodes for way members)

  try {
    const tagsPath = outputPath.replace(".osm.pbf", "-tags.osm.pbf");
    const refsPath = outputPath.replace(".osm.pbf", "-refs.osm.pbf");
    const addrPath = outputPath.replace(".osm.pbf", "-addr.osm.pbf");
    const mergedPath = outputPath.replace(".osm.pbf", "-merged.osm.pbf");

    // Step 1: Filter for places and boundaries (just IDs, no referenced objects)
    console.log("  Step 1/4: Filtering for places and boundaries...");
    await $`osmium tags-filter ${inputPath} nwr/place=suburb,city_district,borough,neighbourhood,quarter nwr/boundary=postal_code nwr/boundary=administrative nwr/place=city,town,municipality,village -o ${tagsPath} --overwrite`;

    // Step 2: Extract those elements with all referenced nodes/ways for complete polygons
    // This ensures relation polygons can be built (relations → ways → nodes)
    // Note: getid returns exit code 1 if some objects aren't found (e.g., referenced
    // objects outside the country extract like cross-border boundaries)
    console.log(
      "  Step 2/4: Extracting with complete references for polygons..."
    );
    // Use --verbose to get count of missing objects, but suppress stdout/stderr
    const getidResult =
      await $`osmium getid -r -I ${tagsPath} ${inputPath} -o ${refsPath} --overwrite --verbose 2>&1`
        .quiet()
        .nothrow();

    if (!existsSync(refsPath)) {
      throw new Error(
        `osmium getid failed to produce output: ${getidResult.text()}`
      );
    }

    // Log if some objects weren't found (expected for cross-border boundaries)
    if (getidResult.exitCode !== 0) {
      const output = getidResult.text();
      const notFoundMatch = output.match(/Did not find (\d+) object/);
      if (notFoundMatch) {
        console.log(
          `    Note: ${notFoundMatch[1]} referenced objects not found (cross-border boundaries)`
        );
      }
    }

    // Step 3: Extract address points to a separate file
    console.log("  Step 3/4: Extracting address points...");
    await $`osmium tags-filter ${inputPath} n/addr:postcode -o ${addrPath} --overwrite`;

    // Step 4: Merge the files
    console.log("  Step 4/4: Merging files...");
    await $`osmium merge ${refsPath} ${addrPath} -o ${mergedPath} --overwrite`;

    // Replace original with merged and clean up
    await $`mv ${mergedPath} ${outputPath}`;
    await $`rm -f ${tagsPath} ${refsPath} ${addrPath}`;
    console.log(`  Filtered to ${outputPath}`);

    // Show size reduction
    const inputFile = Bun.file(inputPath);
    const outputFile = Bun.file(outputPath);
    const inputSize = inputFile.size;
    const outputSize = outputFile.size;
    const reduction = ((1 - outputSize / inputSize) * 100).toFixed(1);
    console.log(
      `  Size: ${formatBytes(inputSize)} -> ${formatBytes(
        outputSize
      )} (${reduction}% reduction)`
    );
  } catch (error) {
    throw new Error(`osmium filter failed: ${error}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Check if osmium is available on the system.
 */
export async function checkOsmiumAvailable(): Promise<boolean> {
  try {
    await $`which osmium`.quiet();
    return true;
  } catch {
    return false;
  }
}
