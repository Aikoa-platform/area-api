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
 * Find areas whose polygon contains a point.
 */
export function findAreasContaining(
  db: Database,
  lat: number,
  lng: number,
  limit: number = 10
): AreaResult[] {
  // Query areas using R-tree (find areas whose bbox contains the point)
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
      // No polygon, check if point is very close to center (within ~100m)
      const distance = haversineDistance(
        { lat, lng },
        { lat: row.center_lat, lng: row.center_lng }
      );

      if (distance < 100) {
        results.push(rowToResult(row, Math.round(distance)));
      }
    }
  }

  // Sort by distance to center
  results.sort((a, b) => (a.distance_meters || 0) - (b.distance_meters || 0));
  return results.slice(0, limit);
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
    .query<AreaRow, [string, string]>(
      `
    SELECT * FROM areas
    WHERE name LIKE ? OR names LIKE ?
    LIMIT ?
  `
    )
    .all(searchPattern, searchPattern);

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
