const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'changeme';

// ============================================
// DATABASE SETUP
// ============================================
const dbPath = path.join(__dirname, 'gps_data.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read/write
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lng REAL NOT NULL,
    lat REAL NOT NULL,
    alt REAL DEFAULT 0,
    speed REAL DEFAULT 0,
    satellites INTEGER DEFAULT 0,
    hdop REAL DEFAULT 0,
    source TEXT DEFAULT 'unknown',
    gps_timestamp TEXT,
    received_at TEXT NOT NULL DEFAULT (datetime('now')),
    geojson TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_received_at ON locations(received_at);
  CREATE INDEX IF NOT EXISTS idx_gps_timestamp ON locations(gps_timestamp);
`);

console.log(`💾 Database initialized: ${dbPath}`);

// Prepared statements for performance
const insertStmt = db.prepare(`
  INSERT INTO locations (lng, lat, alt, speed, satellites, hdop, source, gps_timestamp, geojson)
  VALUES (@lng, @lat, @alt, @speed, @satellites, @hdop, @source, @gps_timestamp, @geojson)
`);

const getLocationsStmt = db.prepare(`
  SELECT id, lng, lat, alt, speed, satellites, hdop, source, gps_timestamp, received_at
  FROM locations
  ORDER BY id DESC
  LIMIT @limit OFFSET @offset
`);

const getLatestStmt = db.prepare(`
  SELECT * FROM locations ORDER BY id DESC LIMIT 1
`);

const getCountStmt = db.prepare(`
  SELECT COUNT(*) as total FROM locations
`);

const getStatsStmt = db.prepare(`
  SELECT
    COUNT(*) as total,
    MIN(received_at) as first_received,
    MAX(received_at) as last_received,
    MIN(lat) as min_lat, MAX(lat) as max_lat,
    MIN(lng) as min_lng, MAX(lng) as max_lng,
    AVG(speed) as avg_speed,
    MAX(speed) as max_speed
  FROM locations
`);

const getLocationsByTimeRange = db.prepare(`
  SELECT id, lng, lat, alt, speed, satellites, hdop, source, gps_timestamp, received_at
  FROM locations
  WHERE received_at BETWEEN @from AND @to
  ORDER BY id DESC
  LIMIT @limit OFFSET @offset
`);

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API KEY AUTHENTICATION
// ============================================
function authMiddleware(req, res, next) {
  // Skip auth for health check, dashboard, SSE stream, and static files
  // Note: since this middleware is mounted at '/api', req.path is relative (e.g. '/stream' not '/api/stream')
  if (req.path === '/health' || req.path === '/' || req.path.startsWith('/public') || req.path === '/stream') {
    return next();
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key. Set X-API-Key header.'
    });
  }
  next();
}

app.use('/api', authMiddleware);

// ============================================
// SERVER-SENT EVENTS (SSE)
// ============================================
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);
  console.log(`📡 SSE client connected (${sseClients.size} total)`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`📡 SSE client disconnected (${sseClients.size} total)`);
  });
});

function broadcastSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// ============================================
// VALIDATE GEOJSON
// ============================================
function isValidGeoJSONPoint(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.type !== 'Feature') return false;
  if (!data.geometry || data.geometry.type !== 'Point') return false;
  if (!Array.isArray(data.geometry.coordinates)) return false;
  if (data.geometry.coordinates.length < 2) return false;

  const [lng, lat] = data.geometry.coordinates;
  if (typeof lng !== 'number' || typeof lat !== 'number') return false;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;

  return true;
}

// ============================================
// API ENDPOINTS
// ============================================

// POST - Receive GPS location(s)
app.post('/api/location', (req, res) => {
  const body = req.body;

  // Support single or array of GeoJSON features
  const features = Array.isArray(body) ? body : [body];
  const results = [];

  const insertMany = db.transaction((items) => {
    for (const geoJSON of items) {
      if (!isValidGeoJSONPoint(geoJSON)) {
        results.push({ success: false, error: 'Invalid GeoJSON Point' });
        continue;
      }

      const [lng, lat, alt] = geoJSON.geometry.coordinates;
      const props = geoJSON.properties || {};

      const info = insertStmt.run({
        lng, lat,
        alt: alt || 0,
        speed: props.speed || 0,
        satellites: props.satellites || 0,
        hdop: props.hdop || 0,
        source: props.source || 'unknown',
        gps_timestamp: props.timestamp || null,
        geojson: JSON.stringify(geoJSON)
      });

      results.push({ success: true, id: info.lastInsertRowid });

      // Broadcast to SSE clients
      broadcastSSE({
        type: 'location',
        id: info.lastInsertRowid,
        lat, lng, alt: alt || 0,
        speed: props.speed || 0,
        satellites: props.satellites || 0,
        timestamp: props.timestamp,
        source: props.source || 'unknown'
      });

      console.log(`📍 Location #${info.lastInsertRowid}: lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}, alt=${(alt || 0).toFixed(1)}m`);
      console.log(`   Speed: ${(props.speed || 0).toFixed(1)} km/h | Sats: ${props.satellites || 0} | Source: ${props.source || 'unknown'}`);
    }
  });

  try {
    insertMany(features);
  } catch (err) {
    console.error('❌ Database error:', err.message);
    return res.status(500).json({ success: false, error: 'Database error' });
  }

  const total = getCountStmt.get().total;
  console.log(`   Total stored: ${total}`);
  console.log('---');

  res.status(200).json({
    success: true,
    message: `${results.length} location(s) received`,
    results,
    storedCount: total
  });
});

// GET - Retrieve location history
app.get('/api/locations', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const from = req.query.from;
  const to = req.query.to;

  let locations;
  if (from && to) {
    locations = getLocationsByTimeRange.all({ from, to, limit, offset });
  } else {
    locations = getLocationsStmt.all({ limit, offset });
  }

  const total = getCountStmt.get().total;

  res.json({
    success: true,
    total,
    count: locations.length,
    limit,
    offset,
    locations
  });
});

// GET - Latest location
app.get('/api/location/latest', (req, res) => {
  const location = getLatestStmt.get();

  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'No locations recorded yet'
    });
  }

  res.json({ success: true, location });
});

// GET - Stats
app.get('/api/stats', (req, res) => {
  const stats = getStatsStmt.get();
  res.json({ success: true, stats });
});

// Health check (no auth required)
app.get('/health', (req, res) => {
  const total = getCountStmt.get().total;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    totalLocations: total,
    sseClients: sseClients.size
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  const total = getCountStmt.get().total;
  console.log('');
  console.log('🛰️  ESP32 GPS Server v2.0');
  console.log(`📡 Listening on http://0.0.0.0:${PORT}`);
  console.log(`💾 Database: ${dbPath} (${total} locations)`);
  console.log(`🔑 API Key: ${API_KEY === 'changeme' ? '⚠️  DEFAULT (set API_KEY env var!)' : '✅ Custom key set'}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  📍 POST /api/location        - Send GPS data`);
  console.log(`  📋 GET  /api/locations        - Get locations (paginated)`);
  console.log(`  🔍 GET  /api/location/latest  - Get latest location`);
  console.log(`  📊 GET  /api/stats            - Get statistics`);
  console.log(`  📡 GET  /api/stream           - SSE real-time stream`);
  console.log(`  🌐 GET  /                     - Live dashboard`);
  console.log(`  ❤️  GET  /health               - Health check`);
  console.log('---');
});
