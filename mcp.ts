/**
 * MCP Server for OSM Area Queries
 *
 * Exposes the locations-server HTTP API as MCP tools for AI agents.
 * Requires the HTTP server to be running (bun run index.ts).
 *
 * Usage:
 *   bun run mcp.ts <api-base-url>
 *   bun run mcp.ts http://localhost:3000
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// API base URL from command line argument (first arg after script name)
const API_BASE = process.argv[2] || "http://localhost:3000";
const API_KEY = process.env.API_KEY;

async function callApi(
  path: string,
  params: Record<string, string | number | boolean | undefined>
): Promise<{ data: unknown; ok: boolean; status: number }> {
  const url = new URL(path, API_BASE);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {};
  if (API_KEY) {
    headers["X-API-Key"] = API_KEY;
  }

  try {
    const response = await fetch(url.toString(), { headers });
    const data = await response.json();
    return { data, ok: response.ok, status: response.status };
  } catch (error) {
    return {
      data: {
        error: `Failed to connect to locations server at ${API_BASE}. Make sure it's running with: bun run index.ts`,
      },
      ok: false,
      status: 503,
    };
  }
}

function formatResponse(result: {
  data: unknown;
  ok: boolean;
  status: number;
}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result.data, null, 2),
      },
    ],
    isError: !result.ok,
  };
}

const server = new McpServer({
  name: "locations-server",
  version: "1.0.0",
});

// Find areas nearby
server.registerTool(
  "areas_nearby",
  {
    title: "Find Areas Nearby",
    description: `Find areas (suburbs, neighborhoods, districts) within a radius of a geographic point.

Use this when you need to:
- Find what neighborhoods are near a location
- Get a list of areas within walking/driving distance
- Discover nearby postal codes

Returns areas sorted by distance, each with name, postal codes, admin levels, and distance in meters.`,
    inputSchema: {
      lat: z.number().min(-90).max(90).describe("Latitude of the center point"),
      lng: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the center point"),
      radius: z
        .number()
        .min(1)
        .max(100000)
        .optional()
        .describe("Search radius in meters (default: 5000)"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results (default: 50)"),
      country_code: z
        .string()
        .optional()
        .describe("Filter by 2-letter country code (e.g., 'FI' for Finland)"),
      group: z
        .boolean()
        .optional()
        .describe(
          "Group postal codes per area (default: true). Set false to get individual area/postal_code rows."
        ),
    },
  },
  async ({ lat, lng, radius, limit, country_code, group }) => {
    const result = await callApi("/areas/nearby", {
      lat,
      lng,
      radius,
      limit,
      country_code,
      group,
    });
    return formatResponse(result);
  }
);

// Find areas containing a point
server.registerTool(
  "areas_containing",
  {
    title: "Find Areas Containing Point",
    description: `Find all areas that contain a specific geographic point.

Use this when you need to:
- Determine which suburb/neighborhood a location is in
- Find the postal code for an address
- Get the administrative hierarchy (district, city, region) for a point

Returns all matching areas from most specific (suburb) to least specific (region).`,
    inputSchema: {
      lat: z.number().min(-90).max(90).describe("Latitude of the point"),
      lng: z.number().min(-180).max(180).describe("Longitude of the point"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results (default: 10)"),
      group: z
        .boolean()
        .optional()
        .describe(
          "Group postal codes per area (default: true). Set false to get individual area/postal_code rows."
        ),
    },
  },
  async ({ lat, lng, limit, group }) => {
    const result = await callApi("/areas/containing", {
      lat,
      lng,
      limit,
      group,
    });
    return formatResponse(result);
  }
);

// Search areas by name
server.registerTool(
  "areas_search",
  {
    title: "Search Areas by Name",
    description: `Search for areas by name with fuzzy matching.

Use this when you need to:
- Find an area by its name (e.g., "Kallio", "Töölö")
- Look up postal codes for a named neighborhood
- Find areas matching a partial name

Supports partial matching. Optionally bias results toward a location for better relevance.`,
    inputSchema: {
      q: z
        .string()
        .min(2)
        .describe("Search query - area name (at least 2 characters)"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of results (default: 20)"),
      country_code: z
        .string()
        .optional()
        .describe("Filter by 2-letter country code (e.g., 'FI' for Finland)"),
      lat: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Latitude to bias results toward (optional)"),
      lng: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Longitude to bias results toward (optional)"),
      group: z
        .boolean()
        .optional()
        .describe(
          "Group postal codes per area (default: true). Set false to get individual area/postal_code rows."
        ),
    },
  },
  async ({ q, limit, country_code, lat, lng, group }) => {
    const result = await callApi("/areas/search", {
      q,
      limit,
      country_code,
      lat,
      lng,
      group,
    });
    return formatResponse(result);
  }
);

// Find adjacent areas
server.registerTool(
  "areas_adjacent",
  {
    title: "Find Adjacent Areas",
    description: `Find areas adjacent to a center point or named area.

Use this when you need to:
- Find neighboring suburbs/districts
- Get areas in specific directions (N, NE, E, SE, S, SW, W, NW)
- Understand the spatial relationship between areas

Returns the center area and surrounding areas with:
- direction: compass direction from center (N, NE, E, etc.)
- level: hierarchical relationship (same, parent, child)

Provide either a name (q) or coordinates (lat/lng) for the center.`,
    inputSchema: {
      q: z
        .string()
        .optional()
        .describe("Name of the center area to find adjacent areas for"),
      lat: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Latitude of center point (used if q is not provided)"),
      lng: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Longitude of center point (used if q is not provided)"),
      radius: z
        .number()
        .min(100)
        .max(100000)
        .optional()
        .describe("Search radius in meters (default: 5000)"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of adjacent areas (default: 20)"),
      country_code: z
        .string()
        .optional()
        .describe("Filter by 2-letter country code (e.g., 'FI' for Finland)"),
    },
  },
  async ({ q, lat, lng, radius, limit, country_code }) => {
    const result = await callApi("/areas/adjacent", {
      q,
      lat,
      lng,
      radius,
      limit,
      country_code,
    });
    return formatResponse(result);
  }
);

// Get stats
server.registerTool(
  "stats",
  {
    title: "Database Statistics",
    description: `Get database statistics and available countries.

Use this to:
- Check which countries are available in the database
- See total counts of areas and postal codes
- Verify the server is working correctly

Returns total_areas, total_postal_codes, and list of available countries with codes.`,
    inputSchema: {},
  },
  async () => {
    const result = await callApi("/stats", {});
    return formatResponse(result);
  }
);

// Health check
server.registerTool(
  "health",
  {
    title: "Health Check",
    description: `Check if the locations server is running and healthy.

Use this before making other API calls to verify the server is available.`,
    inputSchema: {},
  },
  async () => {
    const result = await callApi("/health", {});
    return formatResponse(result);
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
