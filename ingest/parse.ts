/**
 * Parse filtered PBF and insert into SQLite raw tables.
 */

import { Database } from "bun:sqlite";
import { parsePBF, type ParseResult } from "../lib/osm-parser";
import { bboxFromPolygon, centroid } from "../lib/geo";

export interface ParseOptions {
  db: Database;
  filteredPbfPath: string;
  defaultCountryCode: string;
}

/**
 * Parse a filtered PBF file and insert data into raw tables.
 */
export async function parseAndInsert(options: ParseOptions): Promise<void> {
  const { db, filteredPbfPath, defaultCountryCode } = options;

  console.log("\nParsing PBF file...");
  const result = await parsePBF(filteredPbfPath);

  console.log("\nInserting into database...");
  await insertRawAreas(db, result);
  await insertPostalBoundaries(db, result);
  await insertAdminBoundaries(db, result, defaultCountryCode);
  await insertAddressPoints(db, result);

  console.log("Parse and insert complete.");
}

async function insertRawAreas(
  db: Database,
  result: ParseResult
): Promise<void> {
  console.log(`  Inserting ${result.places.length} raw areas...`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO raw_areas 
    (osm_id, osm_type, place_type, names, center_lat, center_lng, polygon,
     bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const place of result.places) {
      let bboxMinLat: number | null = null;
      let bboxMinLng: number | null = null;
      let bboxMaxLat: number | null = null;
      let bboxMaxLng: number | null = null;

      if (place.polygon) {
        const bbox = bboxFromPolygon(place.polygon);
        bboxMinLat = bbox.minLat;
        bboxMinLng = bbox.minLng;
        bboxMaxLat = bbox.maxLat;
        bboxMaxLng = bbox.maxLng;
      }

      insert.run(
        place.osm_id,
        place.osm_type,
        place.place_type,
        JSON.stringify(place.names),
        place.center_lat,
        place.center_lng,
        place.polygon ? JSON.stringify(place.polygon) : null,
        bboxMinLat,
        bboxMinLng,
        bboxMaxLat,
        bboxMaxLng
      );
    }
  });

  insertMany();
  console.log(`    Inserted ${result.places.length} raw areas`);
}

async function insertPostalBoundaries(
  db: Database,
  result: ParseResult
): Promise<void> {
  console.log(
    `  Inserting ${result.postalBoundaries.length} postal boundaries...`
  );

  const insertBoundary = db.prepare(`
    INSERT OR REPLACE INTO postal_boundaries 
    (osm_id, postal_code, polygon, center_lat, center_lng,
     bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRtree = db.prepare(`
    INSERT OR REPLACE INTO postal_rtree (id, min_lat, max_lat, min_lng, max_lng)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const boundary of result.postalBoundaries) {
      if (!boundary.polygon) continue;

      const bbox = bboxFromPolygon(boundary.polygon);
      const center = centroid(boundary.polygon);

      insertBoundary.run(
        boundary.osm_id,
        boundary.postal_code ?? null,
        JSON.stringify(boundary.polygon),
        center.lat,
        center.lng,
        bbox.minLat,
        bbox.minLng,
        bbox.maxLat,
        bbox.maxLng
      );

      // Get the inserted row ID for R-tree
      const row = db
        .query<{ id: number }, [number]>(
          "SELECT id FROM postal_boundaries WHERE osm_id = ?"
        )
        .get(boundary.osm_id);

      if (row) {
        insertRtree.run(
          row.id,
          bbox.minLat,
          bbox.maxLat,
          bbox.minLng,
          bbox.maxLng
        );
      }
    }
  });

  insertMany();
  console.log(
    `    Inserted ${result.postalBoundaries.length} postal boundaries`
  );
}

async function insertAddressPoints(
  db: Database,
  result: ParseResult
): Promise<void> {
  console.log(`  Inserting ${result.addressPoints.length} address points...`);

  const insertPoint = db.prepare(`
    INSERT OR IGNORE INTO address_points (osm_id, lat, lng, postal_code)
    VALUES (?, ?, ?, ?)
  `);

  const insertRtree = db.prepare(`
    INSERT INTO address_rtree (id, min_lat, max_lat, min_lng, max_lng)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    let inserted = 0;
    for (const point of result.addressPoints) {
      insertPoint.run(point.osm_id, point.lat, point.lng, point.postal_code);

      // Get the row ID for R-tree
      const row = db
        .query<{ id: number }, [number]>(
          "SELECT id FROM address_points WHERE osm_id = ?"
        )
        .get(point.osm_id);

      if (row) {
        try {
          insertRtree.run(row.id, point.lat, point.lat, point.lng, point.lng);
        } catch {
          // R-tree entry might already exist, ignore
        }
        inserted++;
      }
    }
    return inserted;
  });

  const count = insertMany();
  console.log(`    Inserted ${count} address points`);
}

async function insertAdminBoundaries(
  db: Database,
  result: ParseResult,
  defaultCountryCode: string
): Promise<void> {
  console.log(
    `  Inserting ${result.adminBoundaries.length} admin boundaries...`
  );

  const insertBoundary = db.prepare(`
    INSERT OR REPLACE INTO admin_boundaries 
    (osm_id, admin_level, name, names, place_type, country_code, polygon,
     center_lat, center_lng, bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRtree = db.prepare(`
    INSERT OR REPLACE INTO admin_rtree (id, min_lat, max_lat, min_lng, max_lng)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction(() => {
    for (const boundary of result.adminBoundaries) {
      let centerLat: number | null = boundary.center_lat ?? null;
      let centerLng: number | null = boundary.center_lng ?? null;
      let bboxMinLat: number | null = null;
      let bboxMinLng: number | null = null;
      let bboxMaxLat: number | null = null;
      let bboxMaxLng: number | null = null;

      if (boundary.polygon) {
        const bbox = bboxFromPolygon(boundary.polygon);
        const center = centroid(boundary.polygon);
        centerLat = center.lat;
        centerLng = center.lng;
        bboxMinLat = bbox.minLat;
        bboxMinLng = bbox.minLng;
        bboxMaxLat = bbox.maxLat;
        bboxMaxLng = bbox.maxLng;
      } else if (centerLat !== null && centerLng !== null) {
        // For point-based places (cities/towns), use center point as bbox
        bboxMinLat = centerLat;
        bboxMaxLat = centerLat;
        bboxMinLng = centerLng;
        bboxMaxLng = centerLng;
      }

      // Use extracted country code or default (null for country-level boundaries)
      const countryCode =
        boundary.country_code ||
        (boundary.admin_level === 2 ? null : defaultCountryCode);

      insertBoundary.run(
        boundary.osm_id,
        boundary.admin_level ?? 0,
        boundary.name,
        boundary.names ? JSON.stringify(boundary.names) : null,
        boundary.place_type ?? null,
        countryCode ?? null,
        boundary.polygon ? JSON.stringify(boundary.polygon) : null,
        centerLat,
        centerLng,
        bboxMinLat,
        bboxMinLng,
        bboxMaxLat,
        bboxMaxLng
      );

      // Add to R-tree if we have bbox
      if (bboxMinLat !== null) {
        const queryResult = db
          .query<{ id: number }, [number]>(
            "SELECT id FROM admin_boundaries WHERE osm_id = ?"
          )
          .get(boundary.osm_id);

        if (queryResult) {
          insertRtree.run(
            queryResult.id,
            bboxMinLat,
            bboxMaxLat,
            bboxMinLng,
            bboxMaxLng
          );
        }
      }
    }
  });

  insertMany();
  console.log(`    Inserted ${result.adminBoundaries.length} admin boundaries`);
}
