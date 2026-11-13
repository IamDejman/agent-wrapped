-- One row per card: the short code people share, and the totals it stands for, as an aw1- code.
CREATE TABLE codes (
  id TEXT PRIMARY KEY,
  totals TEXT NOT NULL UNIQUE
);
