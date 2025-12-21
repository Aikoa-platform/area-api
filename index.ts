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
 *   GET /areas/adjacent?q=name|lat=X&lng=Y
 *   GET /stats
 *   GET /health
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  findAreasNearby,
  findAreasContaining,
  searchAreasByName,
  findAdjacentAreas,
  getStats,
  getCountries,
  groupAreaResults,
} from "./db/queries";
import { initializeDatabase } from "./db/schema";
import type { Server } from "bun";

const DB_PATH = process.env.DB_PATH || "./db/areas.db";
const PORT = parseInt(process.env.PORT || "3000", 10);
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.warn("WARNING: API_KEY not set. Auth disabled for localhost only.");
}

// Initialize database
let db: Database;

if (existsSync(DB_PATH)) {
  db = new Database(DB_PATH, { readonly: true });
  db.run("PRAGMA cache_size = -64000"); // 64MB cache
  console.log(`Loaded database from ${DB_PATH}`);
} else {
  console.log(`Database not found at ${DB_PATH}`);
  console.log("Run the ingestion pipeline first:");
  console.log("  bun run ingest/run.ts --country finland");
  console.log("");
  console.log("Starting with empty database...");
  db = initializeDatabase(DB_PATH);
}

// No CORS headers - server-to-server only
const baseHeaders = {
  "Content-Type": "application/json",
};

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: baseHeaders,
  });
}

function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

function isLocalhost(server: Server<unknown>): boolean {
  return server.hostname === "localhost" || server.hostname === "127.0.0.1";
}

function validateApiKey(req: Request, server: Server<unknown>): boolean {
  // Skip auth for localhost when API_KEY is not set
  if (isLocalhost(server)) return true;

  // Check X-API-Key header
  const apiKeyHeader = req.headers.get("X-API-Key");
  if (apiKeyHeader === API_KEY) return true;

  // Check Authorization: Bearer <key>
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === API_KEY) return true;
  }

  return false;
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

  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check - no auth required (for Railway/monitoring)
    if (path === "/health") {
      return jsonResponse({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    }

    // Validate API key for all other endpoints
    if (!validateApiKey(req, server)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
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
      const group = url.searchParams.get("group") !== "false"; // Default to grouped

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

      // Get more raw results to ensure we have enough after grouping
      const rawLimit = group ? limit * 3 : limit;
      const rawAreas = findAreasNearby(db, lat, lng, radius, rawLimit);

      if (group) {
        const areas = groupAreaResults(rawAreas).slice(0, limit);
        return jsonResponse({ areas, count: areas.length });
      }
      return jsonResponse({
        areas: rawAreas.slice(0, limit),
        count: rawAreas.length,
      });
    }

    // Find areas containing a point
    if (path === "/areas/containing") {
      const lat = parseFloat(url.searchParams.get("lat"));
      const lng = parseFloat(url.searchParams.get("lng"));
      const limit = parseInt(url.searchParams.get("limit"), 10);
      const group = url.searchParams.get("group") !== "false"; // Default to grouped

      if (lat === null || lng === null) {
        return errorResponse("lat and lng query parameters are required");
      }

      if (lat < -90 || lat > 90) {
        return errorResponse("lat must be between -90 and 90");
      }

      if (lng < -180 || lng > 180) {
        return errorResponse("lng must be between -180 and 180");
      }

      const rawLimit = group ? limit * 3 : limit;
      const rawAreas = findAreasContaining(db, lat, lng, rawLimit);

      if (group) {
        const areas = groupAreaResults(rawAreas).slice(0, limit);
        return jsonResponse({ areas, count: areas.length });
      }
      return jsonResponse({
        areas: rawAreas.slice(0, limit),
        count: rawAreas.length,
      });
    }

    // Search areas by name
    if (path === "/areas/search") {
      const query = url.searchParams.get("q");
      const limit = parseInt(url.searchParams.get("limit"), 20);
      const group = url.searchParams.get("group") !== "false"; // Default to grouped

      if (!query || query.length < 2) {
        return errorResponse("q query parameter must be at least 2 characters");
      }

      const rawLimit = group ? limit * 3 : limit;
      const rawAreas = searchAreasByName(db, query, rawLimit);

      if (group) {
        const areas = groupAreaResults(rawAreas).slice(0, limit);
        return jsonResponse({ areas, count: areas.length });
      }
      return jsonResponse({
        areas: rawAreas.slice(0, limit),
        count: rawAreas.length,
      });
    }

    // Find adjacent areas around a center
    if (path === "/areas/adjacent") {
      const query = url.searchParams.get("q");
      const lat = parseFloat(url.searchParams.get("lat"));
      const lng = parseFloat(url.searchParams.get("lng"));
      const radius = parseFloat(url.searchParams.get("radius")) ?? 5000;
      const limit = parseInt(url.searchParams.get("limit"), 20);

      if (!query && (lat === null || lng === null)) {
        return errorResponse(
          "Either q (search query) or lat/lng coordinates are required"
        );
      }

      if (lat !== null && (lat < -90 || lat > 90)) {
        return errorResponse("lat must be between -90 and 90");
      }

      if (lng !== null && (lng < -180 || lng > 180)) {
        return errorResponse("lng must be between -180 and 180");
      }

      if (radius < 100 || radius > 100000) {
        return errorResponse("radius must be between 100 and 100000 meters");
      }

      const result = findAdjacentAreas(db, {
        query: query ?? undefined,
        lat: lat ?? undefined,
        lng: lng ?? undefined,
        radius,
        limit,
      });

      if (!result) {
        return jsonResponse({ center: null, adjacent: [], count: 0 });
      }

      return jsonResponse({
        center: result.center,
        adjacent: result.adjacent,
        count: result.adjacent.length,
      });
    }

    // Not found
    return jsonResponse(
      {
        error: "Not found",
        endpoints: [
          "GET /areas/nearby?lat=X&lng=Y&radius=Z",
          "GET /areas/containing?lat=X&lng=Y",
          "GET /areas/search?q=name",
          "GET /areas/adjacent?q=name|lat=X&lng=Y",
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
console.log(
  "  GET /areas/nearby?lat=X&lng=Y&radius=Z   - Find areas within radius"
);
console.log(
  "  GET /areas/containing?lat=X&lng=Y        - Find areas containing point"
);
console.log(
  "  GET /areas/search?q=name                 - Search areas by name"
);
console.log(
  "  GET /areas/adjacent?q=name|lat=X&lng=Y   - Find adjacent areas with direction/level"
);
console.log("  GET /stats                               - Database statistics");
console.log("  GET /health                              - Health check");
console.log("");
console.log("Options:");
console.log("  group=false - Return individual (area, postal_code) rows");
console.log("  limit=N     - Max number of results");
