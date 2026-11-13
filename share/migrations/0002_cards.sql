-- One row per card link: the id a shared post links to, and the totals its card shows, as an aw1- code.
-- Kept apart from friend codes, so a shared link can't be used to compare with whoever posted it.
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  totals TEXT NOT NULL UNIQUE
);
