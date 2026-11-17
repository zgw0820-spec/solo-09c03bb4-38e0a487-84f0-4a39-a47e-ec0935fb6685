from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cpu_capacity INTEGER NOT NULL CHECK (cpu_capacity > 0),
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'draining', 'drained')),
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
    name TEXT PRIMARY KEY,
    min_ready INTEGER NOT NULL CHECK (min_ready >= 0),
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service TEXT NOT NULL REFERENCES services(name),
    cpu_request INTEGER NOT NULL CHECK (cpu_request > 0),
    node_id TEXT NOT NULL REFERENCES nodes(id),
    status TEXT NOT NULL DEFAULT 'serving'
        CHECK (status IN ('serving')),
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS drains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL REFERENCES nodes(id),
    status TEXT NOT NULL
        CHECK (status IN ('active', 'incomplete', 'completed')),
    created_at TEXT NOT NULL,
    finished_at TEXT
);

-- One row per attempted replica move. Retries append a new row; the latest
-- row per (drain, container) is the container's current attempt.
--
-- State machine:
--   starting          -> reservation held, waiting for the new replica to
--                        become ready (or fail to start)
--   awaiting_cutover  -> the new replica is ready and keeps the target CPU
--                        reserved, but the old replica is still processing a
--                        long request; cutover fires when that request ends
--   completed         -> new replica promoted, old replica stopped
--   failed/blocked    -> reservation released, old replica keeps serving
CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
    container_id TEXT NOT NULL REFERENCES containers(id),
    source_node_id TEXT NOT NULL REFERENCES nodes(id),
    target_node_id TEXT REFERENCES nodes(id),
    state TEXT NOT NULL
        CHECK (state IN (
            'starting', 'awaiting_cutover', 'completed', 'failed', 'blocked'
        )),
    reserved_cpu INTEGER NOT NULL CHECK (reserved_cpu > 0),
    error_code TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Simulated long-running business requests. A running request pins one
-- serving replica (one at most) and defers that replica's drain cutover.
--
-- ``cutover_migration_id`` intentionally has no FOREIGN KEY clause: on a v1
-- database the requests table is created before the legacy migrations table is
-- rebuilt via RENAME, and an FK reference would be rewritten onto the dropped
-- staging table. The id is always validated against migrations in service code.
CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL,
    container_id TEXT REFERENCES containers(id),
    node_id TEXT REFERENCES nodes(id),
    status TEXT NOT NULL
        CHECK (status IN ('running', 'completed', 'rejected')),
    note TEXT,
    result TEXT,
    cutover_migration_id INTEGER,
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_containers_node ON containers(node_id);
CREATE INDEX IF NOT EXISTS idx_migrations_drain ON migrations(drain_id);
CREATE INDEX IF NOT EXISTS idx_migrations_container ON migrations(container_id);
CREATE INDEX IF NOT EXISTS idx_migrations_target ON migrations(target_node_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_container ON requests(container_id);

-- A node may only have one drain that has not completed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_drain_per_node
    ON drains(node_id) WHERE status IN ('active', 'incomplete');

-- A logical container can only have one unresolved migration at a time.
-- ``awaiting_cutover`` still holds the target reservation, so a second
-- migration must not be scheduled for the same container.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_migration_per_container
    ON migrations(container_id)
    WHERE state IN ('starting', 'awaiting_cutover');

-- Each serving replica processes at most one request simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_running_request_per_container
    ON requests(container_id)
    WHERE status = 'running' AND container_id IS NOT NULL;
"""

# Legacy (v1) artefacts that are rebuilt by ``_migrate_legacy_schema``.
_LEGACY_OPEN_MIGRATION_INDEX = "idx_one_starting_migration_per_container"


class Database:
    """Small SQLite helper that opens short-lived, transaction-scoped connections."""

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    def initialize(self) -> None:
        if self.path != ":memory:":
            parent = Path(self.path).expanduser().resolve().parent
            parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            if self.path != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL")
                conn.execute("PRAGMA synchronous = NORMAL")
            conn.executescript(SCHEMA)
            self._migrate_legacy_schema(conn)
        finally:
            conn.close()

    def _migrate_legacy_schema(self, conn: sqlite3.Connection) -> None:
        """Upgrade a v1 database in place without losing rehearsal state.

        SQLite cannot alter a CHECK constraint or a partial index in place, so
        the legacy ``migrations`` table is rebuilt with the extended state
        machine. Existing rows keep their ids and timestamps.
        """
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version >= SCHEMA_VERSION:
            return

        migration_sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'migrations'"
        ).fetchone()
        needs_rebuild = (
            migration_sql is not None
            and "awaiting_cutover" not in (migration_sql[0] or "")
        )
        if needs_rebuild:
            conn.execute("BEGIN IMMEDIATE")
            try:
                # Without this, SQLite 3.26+ rewrites foreign-key references in
                # other tables (e.g. requests.cutover_migration_id) when the
                # migrations table is renamed, leaving them pointing at the
                # throwaway legacy table.
                conn.execute("PRAGMA legacy_alter_table = ON")
                conn.execute(
                    "DROP INDEX IF EXISTS " + _LEGACY_OPEN_MIGRATION_INDEX
                )
                conn.execute("ALTER TABLE migrations RENAME TO migrations_legacy")
                conn.execute(
                    """
                    CREATE TABLE migrations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        drain_id INTEGER NOT NULL REFERENCES drains(id) ON DELETE CASCADE,
                        container_id TEXT NOT NULL REFERENCES containers(id),
                        source_node_id TEXT NOT NULL REFERENCES nodes(id),
                        target_node_id TEXT REFERENCES nodes(id),
                        state TEXT NOT NULL
                            CHECK (state IN (
                                'starting', 'awaiting_cutover', 'completed',
                                'failed', 'blocked'
                            )),
                        reserved_cpu INTEGER NOT NULL CHECK (reserved_cpu > 0),
                        error_code TEXT,
                        error TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO migrations (
                        id, drain_id, container_id, source_node_id, target_node_id,
                        state, reserved_cpu, error_code, error, created_at, updated_at
                    )
                    SELECT
                        id, drain_id, container_id, source_node_id, target_node_id,
                        state, reserved_cpu, error_code, error, created_at, updated_at
                    FROM migrations_legacy
                    """
                )
                conn.execute("DROP TABLE migrations_legacy")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_migrations_drain "
                    "ON migrations(drain_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_migrations_container "
                    "ON migrations(container_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_migrations_target "
                    "ON migrations(target_node_id)"
                )
                conn.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_migration_per_container
                        ON migrations(container_id)
                        WHERE state IN ('starting', 'awaiting_cutover')
                    """
                )
                conn.execute("PRAGMA legacy_alter_table = OFF")
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
        else:
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """Read several tables from one consistent snapshot."""
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """Serialise mutating operations with an immediate write lock."""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()
