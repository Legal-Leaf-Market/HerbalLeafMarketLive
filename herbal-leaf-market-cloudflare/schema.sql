-- Herbal Leaf Market — D1 schema
-- npx wrangler d1 execute herbal-leaf-market --file=./schema.sql --remote
CREATE TABLE IF NOT EXISTS members (
  email TEXT PRIMARY KEY, name TEXT DEFAULT '', joined INTEGER,
  garden TEXT DEFAULT '{}', notified TEXT DEFAULT '{}',
  consent TEXT DEFAULT 'no', unsubscribed TEXT DEFAULT '', last_email INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, vendor TEXT,
  product TEXT, price REAL, category TEXT, page TEXT, device TEXT, email TEXT, ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks (ts);
CREATE INDEX IF NOT EXISTS idx_members_unsub ON members (unsubscribed);
