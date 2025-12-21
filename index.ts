/**
 * OSM Area Server
 *
 * A fast, self-contained server for querying suburb-level areas
 * with postal code combinations.
 *
 * Usage:
 *   bun run index.ts
 *
 * Endpoints:
 *   GET /areas/nearby?lat=X&lng=Y&radius=Z
 *   GET /areas/containing?lat=X&lng=Y
 *   GET /areas/search?q=name
 *   GET /stats
 *   GET /health
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  findAreasNearby,
  findAreasContaining,
  searchAreasByName,
  getStats,
  getCountries,
} from "./db/queries";
import { initializeDatabase } from "./db/schema";

const DB_PATH = process.env.DB_PATH || "./db/areas.db";
const PORT = parseInt(process.env.PORT || "3000", 10);

// Initialize database
let db: Database;

if (existsSync(DB_PATH)) {
  db = new Database(DB_PATH, { readonly: true });
  db.exec("PRAGMA cache_size = -64000"); // 64MB cache
  console.log(`Loaded database from ${DB_PATH}`);
} else {
  console.log(`Database not found at ${DB_PATH}`);
  console.log("Run the ingestion pipeline first:");
  console.log("  bun run ingest/run.ts --country finland");
  console.log("");
  console.log("Starting with empty database...");
  db = initializeDatabase(DB_PATH);
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

function parseFloat(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseInt(value: string | null, defaultValue: number): number {
  if (value === null) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

const server = Bun.serve({
  port: PORT,

  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (path === "/health") {
      return jsonResponse({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Stats
    if (path === "/stats") {
      const stats = getStats(db);
      const countries = getCountries(db);
      return jsonResponse({ ...stats, countries });
    }

    // Find areas nearby
    if (path === "/areas/nearby") {
      const lat = parseFloat(url.searchParams.get("lat"));
      const lng = parseFloat(url.searchParams.get("lng"));
      const radius = parseFloat(url.searchParams.get("radius")) || 5000;
      const limit = parseInt(url.searchParams.get("limit"), 50);

      if (lat === null || lng === null) {
        return errorResponse("lat and lng query parameters are required");
      }

      if (lat < -90 || lat > 90) {
        return errorResponse("lat must be between -90 and 90");
      }

      if (lng < -180 || lng > 180) {
        return errorResponse("lng must be between -180 and 180");
      }

      if (radius <= 0 || radius > 100000) {
        return errorResponse("radius must be between 1 and 100000 meters");
      }

      const areas = findAreasNearby(db, lat, lng, radius, limit);
      return jsonResponse({ areas, count: areas.length });
    }

    // Find areas containing a point
    if (path === "/areas/containing") {
      const lat = parseFloat(url.searchParams.get("lat"));
      const lng = parseFloat(url.searchParams.get("lng"));
      const limit = parseInt(url.searchParams.get("limit"), 10);

      if (lat === null || lng === null) {
        return errorResponse("lat and lng query parameters are required");
      }

      if (lat < -90 || lat > 90) {
        return errorResponse("lat must be between -90 and 90");
      }

      if (lng < -180 || lng > 180) {
        return errorResponse("lng must be between -180 and 180");
      }

      const areas = findAreasContaining(db, lat, lng, limit);
      return jsonResponse({ areas, count: areas.length });
    }

    // Search areas by name
    if (path === "/areas/search") {
      const query = url.searchParams.get("q");
      const limit = parseInt(url.searchParams.get("limit"), 20);

      if (!query || query.length < 2) {
        return errorResponse("q query parameter must be at least 2 characters");
      }

      const areas = searchAreasByName(db, query, limit);
      return jsonResponse({ areas, count: areas.length });
    }

    // Not found
    return jsonResponse(
      {
        error: "Not found",
        endpoints: [
          "GET /areas/nearby?lat=X&lng=Y&radius=Z",
          "GET /areas/containing?lat=X&lng=Y",
          "GET /areas/search?q=name",
          "GET /stats",
          "GET /health",
        ],
      },
      404
    );
  },
});

console.log(`OSM Area Server running on http://localhost:${server.port}`);
console.log("");
console.log("Endpoints:");
console.log("  GET /areas/nearby?lat=X&lng=Y&radius=Z  - Find areas within radius");
console.log("  GET /areas/containing?lat=X&lng=Y       - Find areas containing point");
console.log("  GET /areas/search?q=name               - Search areas by name");
console.log("  GET /stats                             - Database statistics");
console.log("  GET /health                            - Health check");
