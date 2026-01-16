/**
 * Postal code resolution for areas.
 * Intersects area polygons with postal code boundaries to create
 * (area, postal_code) combination rows.
 */

import { Database } from "bun:sqlite";
import { polygonsIntersect, pointInPolygon } from "../lib/geo";
import { normalizeText } from "../lib/search";
import { type HierarchyResult } from "./hierarchy";

interface RawAreaRow {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  names: string;
  center_lat: number;
  center_lng: number;
  polygon: string | null;
  bbox_min_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lat: number | null;
  bbox_max_lng: number | null;
}

interface PostalBoundaryRow {
  id: number;
  osm_id: number;
  postal_code: string;
  polygon: string;
  bbox_min_lat: number;
  bbox_min_lng: number;
  bbox_max_lat: number;
  bbox_max_lng: number;
}

interface AddressPointRow {
  postal_code: string;
  lat: number;
  lng: number;
}

/**
 * Find postal codes by sampling address points within an area.
 */
function findPostalCodesFromAddressPoints(
  db: Database,
  area: RawAreaRow
): string[] {
  // Determine the area's bounds for R-tree query
  let minLat: number, maxLat: number, minLng: number, maxLng: number;

  if (area.bbox_min_lat !== null && area.bbox_max_lat !== null) {
    minLat = area.bbox_min_lat;
    maxLat = area.bbox_max_lat;
    minLng = area.bbox_min_lng!;
    maxLng = area.bbox_max_lng!;
  } else {
    // No bbox, use center point with buffer (~1km for point areas)
    const buffer = 0.01; // ~1km
    minLat = area.center_lat - buffer;
    maxLat = area.center_lat + buffer;
    minLng = area.center_lng - buffer;
    maxLng = area.center_lng + buffer;
  }

  // Find address points within the area's bbox
  const candidates = db
    .query<AddressPointRow, [number, number, number, number]>(
      `
    SELECT DISTINCT ap.postal_code, ap.lat, ap.lng 
    FROM address_points ap
    INNER JOIN address_rtree rt ON ap.id = rt.id
    WHERE rt.max_lat >= ? AND rt.min_lat <= ?
      AND rt.max_lng >= ? AND rt.min_lng <= ?
  `
    )
    .all(minLat, maxLat, minLng, maxLng);

  if (candidates.length === 0) {
    return [];
  }

  // If area has a polygon, filter to points actually inside
  if (area.polygon) {
    const areaPolygon = JSON.parse(area.polygon) as
      | GeoJSON.Polygon
      | GeoJSON.MultiPolygon;

    const postalCodes = new Set<string>();
    for (const point of candidates) {
      if (pointInPolygon({ lat: point.lat, lng: point.lng }, areaPolygon)) {
        postalCodes.add(point.postal_code);
      }
    }
    return Array.from(postalCodes);
  }

  // No polygon - collect unique postal codes from bbox candidates
  const postalCodes = new Set<string>();
  for (const point of candidates) {
    postalCodes.add(point.postal_code);
  }
  return Array.from(postalCodes);
}

/**
 * Find postal codes that intersect with an area's polygon or bbox.
 * First tries postal boundaries, then falls back to address point sampling.
 */
function findIntersectingPostalCodes(db: Database, area: RawAreaRow): string[] {
  // Determine the area's bounds for R-tree query
  let minLat: number, maxLat: number, minLng: number, maxLng: number;

  if (area.bbox_min_lat !== null && area.bbox_max_lat !== null) {
    minLat = area.bbox_min_lat;
    maxLat = area.bbox_max_lat;
    minLng = area.bbox_min_lng!;
    maxLng = area.bbox_max_lng!;
  } else {
    // No bbox, use center point with small buffer (~500m)
    const buffer = 0.005; // ~500m
    minLat = area.center_lat - buffer;
    maxLat = area.center_lat + buffer;
    minLng = area.center_lng - buffer;
    maxLng = area.center_lng + buffer;
  }

  // First, try postal boundaries (some countries use these)
  const postalBoundaries = db
    .query<PostalBoundaryRow, [number, number, number, number]>(
      `
    SELECT pb.* FROM postal_boundaries pb
    INNER JOIN postal_rtree rt ON pb.id = rt.id
    WHERE rt.max_lat >= ? AND rt.min_lat <= ?
      AND rt.max_lng >= ? AND rt.min_lng <= ?
  `
    )
    .all(minLat, maxLat, minLng, maxLng);

  if (postalBoundaries.length > 0) {
    // If area has a polygon, do precise intersection
    if (area.polygon) {
      const areaPolygon = JSON.parse(area.polygon) as
        | GeoJSON.Polygon
        | GeoJSON.MultiPolygon;
      const postalCodes: string[] = [];

      for (const postal of postalBoundaries) {
        const postalPolygon = JSON.parse(postal.polygon) as
          | GeoJSON.Polygon
          | GeoJSON.MultiPolygon;

        if (polygonsIntersect(areaPolygon, postalPolygon)) {
          postalCodes.push(postal.postal_code);
        }
      }

      if (postalCodes.length > 0) {
        return postalCodes;
      }
    } else {
      // No polygon - check if center point is in any postal boundary
      for (const postal of postalBoundaries) {
        const postalPolygon = JSON.parse(postal.polygon) as
          | GeoJSON.Polygon
          | GeoJSON.MultiPolygon;

        if (
          pointInPolygon(
            { lat: area.center_lat, lng: area.center_lng },
            postalPolygon
          )
        ) {
          return [postal.postal_code];
        }
      }
    }
  }

  // Fall back to address point sampling
  return findPostalCodesFromAddressPoints(db, area);
}

/**
 * Find the nearest postal code from address points near a location.
 */
function findNearestPostalCode(
  db: Database,
  lat: number,
  lng: number
): string | null {
  // Search in expanding radius
  for (const buffer of [0.005, 0.01, 0.02, 0.05]) {
    const minLat = lat - buffer;
    const maxLat = lat + buffer;
    const minLng = lng - buffer;
    const maxLng = lng + buffer;

    const point = db
      .query<{ postal_code: string }, [number, number, number, number]>(
        `
      SELECT postal_code FROM address_points ap
      INNER JOIN address_rtree rt ON ap.id = rt.id
      WHERE rt.max_lat >= ? AND rt.min_lat <= ?
        AND rt.max_lng >= ? AND rt.min_lng <= ?
      LIMIT 1
    `
      )
      .get(minLat, maxLat, minLng, maxLng);

    if (point) {
      return point.postal_code;
    }
  }

  return null;
}

export interface ResolvePostalOptions {
  db: Database;
  hierarchies: Map<number, HierarchyResult>;
}

/**
 * Resolve postal codes for all areas and create final area rows.
 */
export function resolvePostalCodes(options: ResolvePostalOptions): void {
  const { db, hierarchies } = options;

  console.log("Resolving postal codes and creating final areas...");

  const areas = db.query<RawAreaRow, []>("SELECT * FROM raw_areas").all();

  const insertArea = db.prepare(`
    INSERT OR REPLACE INTO areas 
    (osm_id, osm_type, place_type, name, names, center_lat, center_lng, polygon,
     postal_code, country_code, country_name, parent_city, parent_city_osm_id, parent_municipality,
     bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRtree = db.prepare(`
    INSERT INTO areas_rtree (id, min_lat, max_lat, min_lng, max_lng)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertFts = db.prepare(`
    INSERT INTO areas_fts (area_id, name, name_normalized, postal_code, all_names)
    VALUES (?, ?, ?, ?, ?)
  `);

  let totalInserted = 0;
  let areasWithoutPostal = 0;

  const insertMany = db.transaction(() => {
    for (const area of areas) {
      const names = JSON.parse(area.names) as Record<string, string>;
      const defaultName = names.default || Object.values(names)[0] || "Unknown";
      const hierarchy = hierarchies.get(area.id) || {
        country_code: null,
        country_name: null,
        parent_city: null,
        parent_city_osm_id: null,
        parent_municipality: null,
      };

      // Find intersecting postal codes
      let postalCodes = findIntersectingPostalCodes(db, area);

      // If no postal codes found, try finding the nearest one
      if (postalCodes.length === 0) {
        const nearest = findNearestPostalCode(
          db,
          area.center_lat,
          area.center_lng
        );
        if (nearest) {
          postalCodes = [nearest];
        }
      }

      // If still no postal codes, create one row with null postal
      if (postalCodes.length === 0) {
        postalCodes = [""]; // Empty string to represent no postal code
        areasWithoutPostal++;
      }

      // Create a row for each (area, postal_code) combination
      for (const postalCode of postalCodes) {
        insertArea.run(
          area.osm_id,
          area.osm_type,
          area.place_type,
          defaultName,
          JSON.stringify(names),
          area.center_lat,
          area.center_lng,
          area.polygon,
          postalCode || null,
          hierarchy.country_code,
          hierarchy.country_name,
          hierarchy.parent_city,
          hierarchy.parent_city_osm_id,
          hierarchy.parent_municipality,
          area.bbox_min_lat,
          area.bbox_min_lng,
          area.bbox_max_lat,
          area.bbox_max_lng
        );

        // Get the inserted ID for R-tree
        const result = db
          .query<
            { id: number },
            [number, string, string | null, string | null]
          >(
            "SELECT id FROM areas WHERE osm_id = ? AND osm_type = ? AND (postal_code = ? OR (postal_code IS NULL AND ? IS NULL))"
          )
          .get(
            area.osm_id,
            area.osm_type,
            postalCode || null,
            postalCode || null
          );

        if (result && area.bbox_min_lat !== null) {
          insertRtree.run(
            result.id,
            area.bbox_min_lat,
            area.bbox_max_lat,
            area.bbox_min_lng,
            area.bbox_max_lng
          );
        } else if (result) {
          // No bbox, use center point
          insertRtree.run(
            result.id,
            area.center_lat,
            area.center_lat,
            area.center_lng,
            area.center_lng
          );
        }

        // Insert into FTS5 index for full-text search
        if (result) {
          // Flatten all name variants into a single searchable string
          const allNamesArray = Object.values(names);
          const allNamesStr = allNamesArray.join(" ");

          insertFts.run(
            result.id,
            defaultName,
            normalizeText(defaultName),
            postalCode || null,
            allNamesStr
          );
        }

        totalInserted++;
      }
    }
  });

  insertMany();

  console.log(
    `  Created ${totalInserted} area rows from ${areas.length} raw areas`
  );
  console.log(`  Areas without postal code: ${areasWithoutPostal}`);
}

/**
 * Get statistics about postal code coverage.
 */
export function getPostalStats(db: Database): {
  totalAreas: number;
  areasWithPostal: number;
  areasWithoutPostal: number;
  uniquePostalCodes: number;
  avgPostalCodesPerArea: number;
} {
  const totalAreas =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(DISTINCT osm_id || '-' || osm_type) as count FROM areas"
      )
      .get()?.count || 0;

  const areasWithPostal =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM areas WHERE postal_code IS NOT NULL AND postal_code != ''"
      )
      .get()?.count || 0;

  const areasWithoutPostal =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM areas WHERE postal_code IS NULL OR postal_code = ''"
      )
      .get()?.count || 0;

  const uniquePostalCodes =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(DISTINCT postal_code) as count FROM areas WHERE postal_code IS NOT NULL AND postal_code != ''"
      )
      .get()?.count || 0;

  const totalRows =
    db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM areas").get()
      ?.count || 0;

  return {
    totalAreas,
    areasWithPostal,
    areasWithoutPostal,
    uniquePostalCodes,
    avgPostalCodesPerArea: totalAreas > 0 ? totalRows / totalAreas : 0,
  };
}
