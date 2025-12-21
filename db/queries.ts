/**
 * Database query functions for the area server API.
 */

import { Database } from "bun:sqlite";
import {
  haversineDistance,
  boundingBoxFromRadius,
  pointInPolygon,
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
 * Search areas by name.
 */
export function searchAreasByName(
  db: Database,
  query: string,
  limit: number = 20
): AreaResult[] {
  const searchPattern = `%${query}%`;

  const rows = db
    .query<AreaRow, [string, string, number]>(
      `
    SELECT * FROM areas
    WHERE name LIKE ? OR names LIKE ?
    LIMIT ?
  `
    )
    .all(searchPattern, searchPattern, limit);

  return rows.map((row) => rowToResult(row));
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
