"""In-place upgrade from a v1 database (no requests table, old migration CHECK)."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

from fastapi.testclient import TestClient

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))

from app.main import create_app  # noqa: E402


LEGACY_SQL = """
CREATE TABLE nodes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    cpu_capacity INTEGER NOT NULL CHECK (cpu_capacity > 0),
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'draining', 'drained')),
    position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE services (
    name TEXT PRIMARY KEY, min_ready INTEGER NOT NULL CHECK (min_ready >= 0),
    position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE containers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, service TEXT NOT NULL,
    cpu_request INTEGER NOT NULL CHECK (cpu_request > 0),
    node_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'serving'
        CHECK (status IN ('serving')), position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE drains (
    id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','incomplete','completed')),
    created_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, drain_id INTEGER NOT NULL,
    container_id TEXT NOT NULL, source_node_id TEXT NOT NULL, target_node_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('starting','completed','failed','blocked')),
    reserved_cpu INTEGER NOT NULL CHECK (reserved_cpu > 0),
    error_code TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_containers_node ON containers(node_id);
CREATE INDEX idx_migrations_drain ON migrations(drain_id);
CREATE INDEX idx_migrations_container ON migrations(container_id);
CREATE INDEX idx_migrations_target ON migrations(target_node_id);
CREATE UNIQUE INDEX idx_one_open_drain_per_node
    ON drains(node_id) WHERE status IN ('active', 'incomplete');
CREATE UNIQUE INDEX idx_one_starting_migration_per_container
    ON migrations(container_id) WHERE state = 'starting';
"""


def _build_legacy_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(LEGACY_SQL)
        conn.execute(
            "INSERT INTO nodes VALUES "
            "('n1','n1',8,'drained',0),('n2','n2',8,'ready',1)"
        )
        conn.execute("INSERT INTO services VALUES ('svc',1,0)")
        conn.execute(
            "INSERT INTO containers VALUES "
            "('c1','c1','svc',2,'n2','serving',0)"
        )
        conn.execute(
            "INSERT INTO drains VALUES "
            "(1,'n1','completed','2026-01-01T00:00:00+00:00',"
            "'2026-01-01T00:01:00+00:00')"
        )
        conn.execute(
            "INSERT INTO migrations VALUES "
            "(1,1,'c1','n1','n2','completed',2,NULL,NULL,"
            "'2026-01-01T00:00:00+00:00','2026-01-01T00:01:00+00:00')"
        )
        conn.commit()
    finally:
        conn.close()


def test_legacy_database_migrates_and_keeps_state(tmp_path):
    db = tmp_path / "legacy.db"
    _build_legacy_db(db)

    with TestClient(create_app(db)) as client:
        state = client.get("/api/state").json()
        # Historical drain and placement survived the table rebuild.
        assert state["drains"][0]["status"] == "completed"
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["node_id"] == "n2"
        # The requests feature now exists on the upgraded schema.
        accepted = client.post("/api/requests", json={"service": "svc"}).json()
        req = accepted["requests"][0]
        assert req["status"] == "running" and req["container_id"] == "c1"

        # A full parked-cutover cycle works on the migrated database.
        client.post("/api/nodes/n1/restore")
        client.post("/api/nodes/n2/drain")
        pending = client.get("/api/state").json()["open_drains"][0][
            "pending_decisions"
        ][0]
        state = client.post(
            f"/api/migrations/{pending['id']}/resolve", json={"outcome": "ready"}
        ).json()
        assert state["open_drains"][0]["awaiting_cutover"] == 1
        state = client.post(
            f"/api/requests/{req['id']}/complete"
        ).json()
        assert state["open_drains"] == []
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["node_id"] == "n1"

    # Reopening must not attempt a second migration.
    with TestClient(create_app(db)) as client:
        state = client.get("/api/state").json()
        assert state["running_request_count"] == 0
        assert client.get("/healthz").status_code == 200


def test_legacy_database_foreign_keys_still_valid(tmp_path):
    """The rebuilt migrations table must keep requests' cutover FK target valid."""
    db = tmp_path / "legacy-fk.db"
    _build_legacy_db(db)
    with TestClient(create_app(db)) as client:
        client.post("/api/requests", json={"service": "svc"})
        client.post("/api/nodes/n1/restore")
        client.post("/api/nodes/n2/drain")
        state = client.get("/api/state").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]
        rid = state["requests"][0]["id"]
        client.post(f"/api/migrations/{mid}/resolve", json={"outcome": "ready"})
        client.post(f"/api/requests/{rid}/complete")

    # Direct integrity check with foreign keys enforced.
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        assert violations == []
    finally:
        conn.close()
