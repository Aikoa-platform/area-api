/**
 * Database query functions for the area server API.
 */

import { Database } from "bun:sqlite";
import {
  haversineDistance,
  boundingBoxFromRadius,
  pointInPolygon,
  calculateBearing,
  roundBearingToSector,
  bearingToCardinal,
  normalizeText,
  fuzzyMatchScore,
} from "../lib/geo";

export interface AreaResult {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: {
    lat: number;
    lng: number;
  };
  postal_code: string | null;
  country_code: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters?: number;
}

export interface GroupedAreaResult {
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: {
    lat: number;
    lng: number;
  };
  postal_codes: string[];
  country_code: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters?: number;
}

interface AreaRow {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: string;
  center_lat: number;
  center_lng: number;
  polygon: string | null;
  postal_code: string | null;
  country_code: string;
  parent_city: string | null;
  parent_municipality: string | null;
}

function rowToResult(row: AreaRow, distance?: number): AreaResult {
  return {
    id: row.id,
    osm_id: row.osm_id,
    osm_type: row.osm_type,
    place_type: row.place_type,
    name: row.name,
    names: JSON.parse(row.names),
    center: {
      lat: row.center_lat,
      lng: row.center_lng,
    },
    postal_code: row.postal_code,
    country_code: row.country_code,
    parent_city: row.parent_city,
    parent_municipality: row.parent_municipality,
    distance_meters: distance,
  };
}

/**
 * Group area results by osm_id, aggregating postal codes.
 */
export function groupAreaResults(results: AreaResult[]): GroupedAreaResult[] {
  const grouped = new Map<string, GroupedAreaResult>();

  for (const result of results) {
    const key = `${result.osm_type}-${result.osm_id}`;
    const existing = grouped.get(key);

    if (existing) {
      if (
        result.postal_code &&
        !existing.postal_codes.includes(result.postal_code)
      ) {
        existing.postal_codes.push(result.postal_code);
      }
      // Keep the smallest distance
      if (result.distance_meters !== undefined) {
        if (
          existing.distance_meters === undefined ||
          result.distance_meters < existing.distance_meters
        ) {
          existing.distance_meters = result.distance_meters;
        }
      }
    } else {
      grouped.set(key, {
        osm_id: result.osm_id,
        osm_type: result.osm_type,
        place_type: result.place_type,
        name: result.name,
        names: result.names,
        center: result.center,
        postal_codes: result.postal_code ? [result.postal_code] : [],
        country_code: result.country_code,
        parent_city: result.parent_city,
        parent_municipality: result.parent_municipality,
        distance_meters: result.distance_meters,
      });
    }
  }

  // Convert to array and sort by distance
  const results_array = Array.from(grouped.values());
  results_array.sort(
    (a, b) => (a.distance_meters ?? 0) - (b.distance_meters ?? 0)
  );
  return results_array;
}

/**
 * Find areas within a radius of a point.
 */
export function findAreasNearby(
  db: Database,
  lat: number,
  lng: number,
  radiusMeters: number,
  limit: number = 50
): AreaResult[] {
  // Calculate bounding box for R-tree query
  const bbox = boundingBoxFromRadius({ lat, lng }, radiusMeters);

  // Query areas using R-tree
  const rows = db
    .query<AreaRow, [number, number, number, number]>(
      `
    SELECT a.* FROM areas a
    INNER JOIN areas_rtree rt ON a.id = rt.id
    WHERE rt.max_lat >= ? AND rt.min_lat <= ?
      AND rt.max_lng >= ? AND rt.min_lng <= ?
  `
    )
    .all(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);

  // Calculate actual distances and filter
  const results: AreaResult[] = [];

  for (const row of rows) {
    const distance = haversineDistance(
      { lat, lng },
      { lat: row.center_lat, lng: row.center_lng }
    );

    if (distance <= radiusMeters) {
      results.push(rowToResult(row, Math.round(distance)));
    }
  }

  // Sort by distance and limit
  results.sort((a, b) => (a.distance_meters || 0) - (b.distance_meters || 0));
  return results.slice(0, limit);
}

/**
 * Find areas whose polygon contains a point, or nearest areas if no polygon match.
 */
export function findAreasContaining(
  db: Database,
  lat: number,
  lng: number,
  limit: number = 10
): AreaResult[] {
  // First, try to find areas whose bbox contains the point
  const rows = db
    .query<AreaRow, [number, number, number, number]>(
      `
    SELECT a.* FROM areas a
    INNER JOIN areas_rtree rt ON a.id = rt.id
    WHERE rt.min_lat <= ? AND rt.max_lat >= ?
      AND rt.min_lng <= ? AND rt.max_lng >= ?
  `
    )
    .all(lat, lat, lng, lng);

  const results: AreaResult[] = [];

  for (const row of rows) {
    // If area has a polygon, check precise containment
    if (row.polygon) {
      try {
        const polygon = JSON.parse(row.polygon) as
          | GeoJSON.Polygon
          | GeoJSON.MultiPolygon;

        if (pointInPolygon({ lat, lng }, polygon)) {
          const distance = haversineDistance(
            { lat, lng },
            { lat: row.center_lat, lng: row.center_lng }
          );
          results.push(rowToResult(row, Math.round(distance)));
        }
      } catch {
        // Invalid polygon, skip
      }
    } else {
      // No polygon - include it but with distance for sorting
      const distance = haversineDistance(
        { lat, lng },
        { lat: row.center_lat, lng: row.center_lng }
      );
      results.push(rowToResult(row, Math.round(distance)));
    }
  }

  // If we found polygon matches, return only those (sorted by distance)
  const polygonMatches = results.filter(
    (r) => r.distance_meters !== undefined && r.distance_meters < 500
  );
  if (polygonMatches.length > 0) {
    polygonMatches.sort(
      (a, b) => (a.distance_meters || 0) - (b.distance_meters || 0)
    );
    return polygonMatches.slice(0, limit);
  }

  // Otherwise, fall back to nearby search with a small radius
  return findAreasNearby(db, lat, lng, 1000, limit);
}

/**
 * Search areas by name or postal code with fuzzy matching.
 * Uses multiple strategies: exact, prefix, contains, and Levenshtein distance.
 * All matching is case-insensitive.
 */
export function searchAreasByName(
  db: Database,
  query: string,
  limit: number = 20
): AreaResult[] {
  // Normalize query: lowercase and remove diacritics
  const lowerQuery = query.toLowerCase().trim();
  const normalizedQuery = normalizeText(query);

  // Get more candidates than needed for fuzzy filtering
  const candidateLimit = Math.max(limit * 5, 100);

  // Check if query looks like a postal code (numeric or alphanumeric)
  const isPostalCodeQuery = /^[\d\w]{2,10}$/i.test(lowerQuery);

  // Search patterns (all lowercase for case-insensitive matching)
  const exactPattern = lowerQuery;
  const prefixPattern = `${lowerQuery}%`;
  const containsPattern = `%${lowerQuery}%`;
  const normalizedPrefixPattern = `${normalizedQuery}%`;
  const normalizedContainsPattern = `%${normalizedQuery}%`;

  // Build query based on whether we're also searching postal codes
  let rows: AreaRow[];

  if (isPostalCodeQuery) {
    // Search both names and postal codes
    rows = db
      .query<
        AreaRow,
        [string, string, string, string, string, string, string, string, number]
      >(
        `
      SELECT DISTINCT * FROM areas
      WHERE LOWER(name) = ?
         OR LOWER(name) LIKE ?
         OR LOWER(name) LIKE ?
         OR LOWER(name) LIKE ?
         OR LOWER(name) LIKE ?
         OR LOWER(names) LIKE ?
         OR postal_code = ?
         OR postal_code LIKE ?
      LIMIT ?
    `
      )
      .all(
        exactPattern,
        prefixPattern,
        containsPattern,
        normalizedPrefixPattern,
        normalizedContainsPattern,
        containsPattern,
        lowerQuery.toUpperCase(), // Postal codes are often uppercase
        `${lowerQuery.toUpperCase()}%`,
        candidateLimit
      );
  } else {
    // Search names only
    rows = db
      .query<AreaRow, [string, string, string, string, string, string, number]>(
        `
      SELECT DISTINCT * FROM areas
      WHERE LOWER(name) = ?
         OR LOWER(name) LIKE ?
         OR LOWER(name) LIKE ?
         OR LOWER(name) LIKE ?
         OR LOWER(name) LIKE ?
         OR LOWER(names) LIKE ?
      LIMIT ?
    `
      )
      .all(
        exactPattern,
        prefixPattern,
        containsPattern,
        normalizedPrefixPattern,
        normalizedContainsPattern,
        containsPattern,
        candidateLimit
      );
  }

  // Score each result using fuzzy matching
  const scoredResults: Array<{ row: AreaRow; score: number }> = [];

  for (const row of rows) {
    let bestScore = 0;

    // Check postal code match (highest priority for postal code queries)
    if (row.postal_code) {
      const postalLower = row.postal_code.toLowerCase();
      if (postalLower === lowerQuery) {
        bestScore = 1.0; // Exact postal code match
      } else if (postalLower.startsWith(lowerQuery)) {
        bestScore = 0.95; // Postal code prefix match
      }
    }

    // Check main name (case-insensitive)
    const nameScore = fuzzyMatchScore(lowerQuery, row.name.toLowerCase());
    if (nameScore > bestScore) {
      bestScore = nameScore;
    }

    // Also check translated names
    try {
      const names = JSON.parse(row.names) as Record<string, string>;
      for (const translatedName of Object.values(names)) {
        const translatedScore = fuzzyMatchScore(
          lowerQuery,
          translatedName.toLowerCase()
        );
        if (translatedScore > bestScore) {
          bestScore = translatedScore;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    if (bestScore > 0) {
      scoredResults.push({ row, score: bestScore });
    }
  }

  // Sort by score (highest first) and limit
  scoredResults.sort((a, b) => b.score - a.score);

  return scoredResults.slice(0, limit).map(({ row }) => rowToResult(row));
}

/**
 * Get all unique country codes in the database.
 */
export function getCountries(db: Database): string[] {
  const rows = db
    .query<{ country_code: string }, []>(
      "SELECT DISTINCT country_code FROM areas ORDER BY country_code"
    )
    .all();

  return rows.map((r) => r.country_code);
}

/**
 * Get statistics about the database.
 */
export function getStats(db: Database): {
  totalAreas: number;
  countriesCount: number;
  postalCodesCount: number;
  citiesCount: number;
} {
  const totalAreas =
    db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM areas").get()
      ?.count || 0;

  const countriesCount =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(DISTINCT country_code) as count FROM areas"
      )
      .get()?.count || 0;

  const postalCodesCount =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(DISTINCT postal_code) as count FROM areas WHERE postal_code IS NOT NULL"
      )
      .get()?.count || 0;

  const citiesCount =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(DISTINCT parent_city) as count FROM areas WHERE parent_city IS NOT NULL"
      )
      .get()?.count || 0;

  return {
    totalAreas,
    countriesCount,
    postalCodesCount,
    citiesCount,
  };
}

/**
 * Adjacent area result with direction and level information.
 */
export interface AdjacentAreaResult {
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: {
    lat: number;
    lng: number;
  };
  postal_codes: string[];
  country_code: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters: number;
  /** Direction from center in degrees (0=N, 90=E, 180=S, 270=W), rounded to 45° */
  degrees: number;
  /** Cardinal direction (N, NE, E, SE, S, SW, W, NW) */
  direction: string;
  /** Level/ring from center (0=center, 1=adjacent, 2=next ring, etc.) */
  level: number;
}

export interface AdjacentSearchResult {
  center: GroupedAreaResult;
  adjacent: AdjacentAreaResult[];
}

/**
 * Find a center area by search term (uses fuzzy matching).
 */
function findCenterBySearch(
  db: Database,
  query: string
): GroupedAreaResult | null {
  // Use the fuzzy search to get candidates
  const candidates = searchAreasByName(db, query, 10);

  if (candidates.length === 0) return null;

  const grouped = groupAreaResults(candidates);
  return grouped[0] ?? null;
}

/**
 * Find a center area by location.
 */
function findCenterByLocation(
  db: Database,
  lat: number,
  lng: number
): GroupedAreaResult | null {
  const nearby = findAreasNearby(db, lat, lng, 2000, 5);
  if (nearby.length === 0) return null;

  const grouped = groupAreaResults(nearby);
  return grouped[0] ?? null;
}

/**
 * Find adjacent areas around a center, with direction and level information.
 */
export function findAdjacentAreas(
  db: Database,
  options: {
    query?: string;
    lat?: number;
    lng?: number;
    radius?: number;
    limit?: number;
  }
): AdjacentSearchResult | null {
  const { query, lat, lng, radius = 5000, limit = 20 } = options;

  // Find the center area
  let center: GroupedAreaResult | null = null;

  if (query) {
    center = findCenterBySearch(db, query);
  } else if (lat !== undefined && lng !== undefined) {
    center = findCenterByLocation(db, lat, lng);
  }

  if (!center) {
    return null;
  }

  // Find nearby areas around the center
  const centerLat = center.center.lat;
  const centerLng = center.center.lng;
  const nearby = findAreasNearby(db, centerLat, centerLng, radius, limit * 3);
  const grouped = groupAreaResults(nearby);

  // Filter out the center itself and calculate direction/level
  const adjacentWithDirection: Array<
    GroupedAreaResult & { degrees: number; distance: number }
  > = [];

  for (const area of grouped) {
    // Skip the center itself
    if (area.osm_id === center.osm_id && area.osm_type === center.osm_type) {
      continue;
    }

    const bearing = calculateBearing(
      { lat: centerLat, lng: centerLng },
      { lat: area.center.lat, lng: area.center.lng }
    );
    const degrees = roundBearingToSector(bearing, 8);
    const distance = area.distance_meters ?? 0;

    adjacentWithDirection.push({
      ...area,
      degrees,
      distance,
    });
  }

  // Group by direction sector and assign levels
  const sectorMap = new Map<number, typeof adjacentWithDirection>();
  for (const area of adjacentWithDirection) {
    const sector = area.degrees;
    if (!sectorMap.has(sector)) {
      sectorMap.set(sector, []);
    }
    sectorMap.get(sector)!.push(area);
  }

  // Sort each sector by distance and assign levels
  const adjacentResults: AdjacentAreaResult[] = [];
  for (const [sector, areas] of sectorMap) {
    // Sort by distance within each sector
    areas.sort((a, b) => a.distance - b.distance);

    // Assign levels (1, 2, 3, ...)
    for (let i = 0; i < areas.length; i++) {
      const area = areas[i]!;
      adjacentResults.push({
        osm_id: area.osm_id,
        osm_type: area.osm_type,
        place_type: area.place_type,
        name: area.name,
        names: area.names,
        center: area.center,
        postal_codes: area.postal_codes,
        country_code: area.country_code,
        parent_city: area.parent_city,
        parent_municipality: area.parent_municipality,
        distance_meters: area.distance,
        degrees: sector,
        direction: bearingToCardinal(sector),
        level: i + 1,
      });
    }
  }

  // Sort by level first, then by degrees for consistent ordering
  adjacentResults.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return a.degrees - b.degrees;
  });

  return {
    center: {
      ...center,
      distance_meters: 0,
    },
    adjacent: adjacentResults.slice(0, limit),
  };
}
