/**
 * Resolve parent cities and country codes for raw areas using admin boundaries.
 */

import { Database } from "bun:sqlite";
import { pointInPolygon } from "../lib/geo";

interface RawAreaRow {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  names: string;
  center_lat: number;
  center_lng: number;
  polygon: string | null;
}

interface AdminBoundaryRow {
  id: number;
  osm_id: number;
  admin_level: number;
  name: string;
  names: string | null;
  place_type: string | null;
  country_code: string | null;
  polygon: string | null;
}

export interface HierarchyResult {
  country_code: string | null;
  country_name: string | null;
  parent_city: string | null;
  parent_city_osm_id: number | null;
  parent_municipality: string | null;
}

/**
 * Find the containing admin boundaries for a point.
 */
export function findContainingBoundaries(
  db: Database,
  lat: number,
  lng: number
): AdminBoundaryRow[] {
  // Use R-tree to find candidate boundaries whose bbox contains the point
  const candidates = db
    .query<AdminBoundaryRow, [number, number, number, number]>(
      `
    SELECT ab.* FROM admin_boundaries ab
    INNER JOIN admin_rtree rt ON ab.id = rt.id
    WHERE rt.min_lat <= ? AND rt.max_lat >= ?
      AND rt.min_lng <= ? AND rt.max_lng >= ?
    ORDER BY ab.admin_level DESC
  `
    )
    .all(lat, lat, lng, lng);

  // Filter to those whose polygon actually contains the point
  const containing: AdminBoundaryRow[] = [];

  for (const candidate of candidates) {
    if (!candidate.polygon) continue;

    try {
      const polygon = JSON.parse(candidate.polygon) as
        | GeoJSON.Polygon
        | GeoJSON.MultiPolygon;
      if (pointInPolygon({ lat, lng }, polygon)) {
        containing.push(candidate);
      }
    } catch {
      // Invalid polygon JSON, skip
    }
  }

  return containing;
}

/**
 * Find the nearest city/town to a point.
 */
function findNearestCity(
  db: Database,
  lat: number,
  lng: number
): { name: string; osm_id: number } | null {
  // Search for cities/towns within expanding radius
  for (const buffer of [0.05, 0.1, 0.2, 0.5]) {
    const minLat = lat - buffer;
    const maxLat = lat + buffer;
    const minLng = lng - buffer;
    const maxLng = lng + buffer;

    // Find city/town places within bbox
    const candidates = db
      .query<
        {
          osm_id: number;
          name: string;
          center_lat: number;
          center_lng: number;
        },
        [number, number, number, number]
      >(
        `
      SELECT ab.osm_id, ab.name, ab.center_lat, ab.center_lng
      FROM admin_boundaries ab
      INNER JOIN admin_rtree rt ON ab.id = rt.id
      WHERE rt.max_lat >= ? AND rt.min_lat <= ?
        AND rt.max_lng >= ? AND rt.min_lng <= ?
        AND ab.admin_level = 99
        AND ab.place_type IN ('city', 'town')
        AND ab.center_lat IS NOT NULL
    `
      )
      .all(minLat, maxLat, minLng, maxLng);

    if (candidates.length > 0) {
      // Find the closest one
      let closest = candidates[0]!;
      let minDist =
        Math.pow(lat - closest.center_lat, 2) +
        Math.pow(lng - closest.center_lng, 2);

      for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const dist =
          Math.pow(lat - candidate.center_lat, 2) +
          Math.pow(lng - candidate.center_lng, 2);
        if (dist < minDist) {
          minDist = dist;
          closest = candidate;
        }
      }

      return { name: closest.name, osm_id: closest.osm_id };
    }
  }

  return null;
}

/**
 * Resolve hierarchy for a single point.
 */
export function resolveHierarchy(
  db: Database,
  lat: number,
  lng: number,
  defaultCountryCode: string,
  defaultCountryName: string
): HierarchyResult {
  const boundaries = findContainingBoundaries(db, lat, lng);

  let country_code: string | null = null;
  let parent_city: string | null = null;
  let parent_city_osm_id: number | null = null;
  let parent_municipality: string | null = null;

  for (const boundary of boundaries) {
    // admin_level=2 is country
    if (boundary.admin_level === 2 && boundary.country_code) {
      country_code = boundary.country_code;
    }

    // admin_level=8 in Finland is municipality
    // In other countries this varies, but 8 is often municipality/city level
    if (boundary.admin_level === 8 && !parent_municipality) {
      parent_municipality = boundary.name;
    }

    // Look for city/town places (admin_level 99 = place-based)
    if (boundary.admin_level === 99) {
      if (boundary.place_type === "city" || boundary.place_type === "town") {
        if (!parent_city) {
          parent_city = boundary.name;
          parent_city_osm_id = boundary.osm_id;
        }
      }
    }

    // Some cities are admin_level=7 or lower
    if (boundary.admin_level >= 6 && boundary.admin_level <= 8) {
      // Check if this looks like a city (has certain size indicators)
      if (!parent_city && boundary.place_type) {
        if (boundary.place_type === "city" || boundary.place_type === "town") {
          parent_city = boundary.name;
          parent_city_osm_id = boundary.osm_id;
        }
      }
    }
  }

  // If no parent city found from polygons, find the nearest city/town
  if (!parent_city) {
    const nearest = findNearestCity(db, lat, lng);
    if (nearest) {
      parent_city = nearest.name;
      parent_city_osm_id = nearest.osm_id;
    }
  }

  // Fall back to municipality as city if no city found
  if (!parent_city && parent_municipality) {
    parent_city = parent_municipality;
  }

  return {
    country_code: country_code || defaultCountryCode,
    country_name: defaultCountryName,
    parent_city,
    parent_city_osm_id,
    parent_municipality,
  };
}

/**
 * Resolve hierarchy for all raw areas and cache results.
 */
export function resolveAllHierarchies(
  db: Database,
  defaultCountryCode: string,
  defaultCountryName: string
): Map<number, HierarchyResult> {
  console.log("Resolving hierarchy for all areas...");

  const areas = db.query<RawAreaRow, []>("SELECT * FROM raw_areas").all();
  const results = new Map<number, HierarchyResult>();

  let processed = 0;
  for (const area of areas) {
    const hierarchy = resolveHierarchy(
      db,
      area.center_lat,
      area.center_lng,
      defaultCountryCode,
      defaultCountryName
    );
    results.set(area.id, hierarchy);

    processed++;
    if (processed % 100 === 0) {
      console.log(`  Processed ${processed}/${areas.length} areas`);
    }
  }

  console.log(`  Resolved hierarchy for ${results.size} areas`);
  return results;
}
