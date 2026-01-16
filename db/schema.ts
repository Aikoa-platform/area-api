import { Database } from "bun:sqlite";
import type { Area, RawArea, PostalBoundary, AdminBoundary } from "../types";

export function initializeDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent read performance
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -64000"); // 64MB cache

  // Create raw areas table (intermediate, for processing)
  db.run(`
    CREATE TABLE IF NOT EXISTS raw_areas (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      osm_type TEXT NOT NULL,
      place_type TEXT NOT NULL,
      names TEXT NOT NULL,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      polygon TEXT,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_type, osm_id)
    )
  `);

  // Create postal code boundaries table
  db.run(`
    CREATE TABLE IF NOT EXISTS postal_boundaries (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      postal_code TEXT NOT NULL,
      polygon TEXT NOT NULL,
      center_lat REAL,
      center_lng REAL,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_id)
    )
  `);

  // Create administrative boundaries table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_boundaries (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      admin_level INTEGER NOT NULL,
      name TEXT NOT NULL,
      names TEXT,
      place_type TEXT,
      country_code TEXT,
      polygon TEXT,
      center_lat REAL,
      center_lng REAL,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_id)
    )
  `);

  // Create final denormalized areas table
  db.run(`
    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      osm_type TEXT NOT NULL,
      place_type TEXT NOT NULL,
      name TEXT NOT NULL,
      names TEXT NOT NULL,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      polygon TEXT,
      postal_code TEXT,
      country_code TEXT NOT NULL,
      country_name TEXT NOT NULL,
      parent_city TEXT,
      parent_city_osm_id INTEGER,
      parent_municipality TEXT,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_type, osm_id, postal_code)
    )
  `);

  // Create R-tree spatial index for areas
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS areas_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create R-tree for postal boundaries (used during processing)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS postal_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create R-tree for admin boundaries (used during processing)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS admin_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create address points table for postal code sampling
  db.run(`
    CREATE TABLE IF NOT EXISTS address_points (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      postal_code TEXT NOT NULL,
      UNIQUE(osm_id)
    )
  `);

  // R-tree for address points
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS address_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create FTS5 full-text search index for areas
  // Uses trigram tokenizer for substring matching
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS areas_fts USING fts5(
      area_id UNINDEXED,
      name,
      name_normalized,
      postal_code,
      all_names,
      tokenize="trigram"
    )
  `);

  // Create indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_areas_name ON areas(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_areas_postal ON areas(postal_code)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_areas_country ON areas(country_code)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_admin_level ON admin_boundaries(admin_level)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_admin_country ON admin_boundaries(country_code)`
  );

  return db;
}

export function clearProcessingTables(db: Database): void {
  db.run("DELETE FROM raw_areas");
  db.run("DELETE FROM postal_boundaries");
  db.run("DELETE FROM admin_boundaries");
  db.run("DELETE FROM address_points");
  db.run("DELETE FROM postal_rtree");
  db.run("DELETE FROM admin_rtree");
  db.run("DELETE FROM address_rtree");
}

export function clearFinalTables(db: Database): void {
  db.run("DELETE FROM areas");
  db.run("DELETE FROM areas_rtree");
  db.run("DELETE FROM areas_fts");
}

// Re-export types for backward compatibility
export type { Area, RawArea, PostalBoundary, AdminBoundary };
