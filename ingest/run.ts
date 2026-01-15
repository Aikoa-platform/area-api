#!/usr/bin/env bun
/**
 * CLI orchestrator for the ingestion pipeline.
 *
 * Usage:
 *   bun run ingest/run.ts --country finland
 *   bun run ingest/run.ts --country finland --skip-download
 *   bun run ingest/run.ts --country finland --skip-filter
 */

import { parseArgs } from "util";

import {
  initializeDatabase,
  clearProcessingTables,
  clearFinalTables,
} from "../db/schema";
import {
  downloadCountry,
  getSupportedCountries,
  checkOsmiumAvailable,
} from "./download";
import { parseAndInsert } from "./parse";
import { resolveAllHierarchies } from "./hierarchy";
import { resolvePostalCodes, getPostalStats } from "./postal";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    country: {
      type: "string",
      short: "c",
    },
    "country-name": {
      type: "string",
      short: "n",
    },
    "data-dir": {
      type: "string",
      short: "d",
      default: "./data",
    },
    "db-path": {
      type: "string",
      default: "./db/areas.db",
    },
    "skip-download": {
      type: "boolean",
      default: false,
    },
    "skip-filter": {
      type: "boolean",
      default: false,
    },
    "clear-db": {
      type: "boolean",
      default: false,
    },
    help: {
      type: "boolean",
      short: "h",
      default: false,
    },
    list: {
      type: "boolean",
      short: "l",
      default: false,
    },
  },
});

function printHelp() {
  console.log(`
OSM Area Server - Ingestion Pipeline

Usage:
  bun run ingest/run.ts --country <country> [options]

Options:
  -c, --country <name>      Country to ingest (required)
  -n, --country-name <name> English name of the country (default: derived from country)
  -d, --data-dir <path>     Directory for PBF files (default: ./data)
  --db-path <path>          Path to SQLite database (default: ./db/areas.db)
  --skip-download           Skip downloading PBF (use existing file)
  --skip-filter             Skip osmium filtering (use existing filtered file)
  --clear-db                Clear database before ingesting
  -l, --list                List supported countries
  -h, --help                Show this help

Examples:
  bun run ingest/run.ts --country finland
  bun run ingest/run.ts -c sweden --skip-download
  bun run ingest/run.ts -c norway --clear-db
  bun run ingest/run.ts -c united-kingdom --country-name "United Kingdom"
`);
}

async function main() {
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.list) {
    console.log("Supported countries:");
    for (const country of getSupportedCountries()) {
      console.log(`  - ${country}`);
    }
    process.exit(0);
  }

  if (!values.country) {
    console.error("Error: --country is required");
    printHelp();
    process.exit(1);
  }

  const country = values.country;
  const countryName = values["country-name"];
  const dataDir = values["data-dir"]!;
  const dbPath = values["db-path"]!;

  console.log("=".repeat(60));
  console.log("OSM Area Server - Ingestion Pipeline");
  console.log("=".repeat(60));
  console.log(`Country: ${country}`);
  if (countryName) {
    console.log(`Country name: ${countryName}`);
  }
  console.log(`Data directory: ${dataDir}`);
  console.log(`Database: ${dbPath}`);
  console.log("");

  // Check osmium availability
  if (!values["skip-filter"]) {
    const osmiumAvailable = await checkOsmiumAvailable();
    if (!osmiumAvailable) {
      console.error("Error: osmium-tool is required but not found.");
      console.error("Install with:");
      console.error("  macOS: brew install osmium-tool");
      console.error("  Ubuntu: apt install osmium-tool");
      console.error("  Fedora: dnf install osmium-tool");
      process.exit(1);
    }
  }

  const startTime = Date.now();

  // Step 1: Download and filter
  console.log("\n[Step 1/4] Download and filter OSM data");
  console.log("-".repeat(40));

  const downloadResult = await downloadCountry({
    dataDir,
    country,
    countryName,
    skipDownload: values["skip-download"],
    skipFilter: values["skip-filter"],
  });

  // Step 2: Initialize database and parse
  console.log("\n[Step 2/4] Parse PBF and insert into database");
  console.log("-".repeat(40));

  const db = initializeDatabase(dbPath);

  if (values["clear-db"]) {
    console.log("Clearing database...");
    clearProcessingTables(db);
    clearFinalTables(db);
  }

  await parseAndInsert({
    db,
    filteredPbfPath: downloadResult.filteredPbfPath,
    defaultCountryCode: downloadResult.countryCode,
  });

  // Step 3: Resolve hierarchy
  console.log("\n[Step 3/4] Resolve administrative hierarchy");
  console.log("-".repeat(40));

  const hierarchies = resolveAllHierarchies(
    db,
    downloadResult.countryCode,
    downloadResult.countryName
  );

  // Step 4: Resolve postal codes and create final areas
  console.log("\n[Step 4/4] Resolve postal codes and create final areas");
  console.log("-".repeat(40));

  resolvePostalCodes({ db, hierarchies });

  // Print statistics
  const stats = getPostalStats(db);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n" + "=".repeat(60));
  console.log("Ingestion Complete!");
  console.log("=".repeat(60));
  console.log(`Duration: ${duration}s`);
  console.log(`Total areas: ${stats.totalAreas}`);
  console.log(`Areas with postal codes: ${stats.areasWithPostal}`);
  console.log(`Areas without postal codes: ${stats.areasWithoutPostal}`);
  console.log(`Unique postal codes: ${stats.uniquePostalCodes}`);
  console.log(
    `Avg postal codes per area: ${stats.avgPostalCodesPerArea.toFixed(2)}`
  );
  console.log("");

  // Show sample data
  console.log("Sample areas:");
  const samples = db
    .query<
      {
        name: string;
        postal_code: string | null;
        parent_city: string | null;
        country_code: string;
        country_name: string;
      },
      []
    >(
      "SELECT name, postal_code, parent_city, country_code, country_name FROM areas ORDER BY RANDOM() LIMIT 5"
    )
    .all();

  for (const sample of samples) {
    console.log(
      `  - ${sample.name}${
        sample.postal_code ? ` (${sample.postal_code})` : ""
      } - ${sample.parent_city || "?"}, ${sample.country_name} (${
        sample.country_code
      })`
    );
  }

  db.close();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
