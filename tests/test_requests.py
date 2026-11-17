"""Long-running business requests interacting with node drains.

Covers the rehearsal contract:

* a request is pinned to one serving replica (one at most) and the UI read
  model shows which replica accepted it;
* draining nodes' old replicas and parked/starting replicas refuse new work,
  and "no replica available" is an explicit rejection, not a silent drop;
* a replica that is still processing a request is never stopped: the ready
  migration parks in ``awaiting_cutover`` while the target CPU stays reserved,
  and drain progress / service ready counts do not move;
* the cutover fires exactly once, inside the request-completion transaction;
* a failed new replica releases its reservation while the original request
  still completes on the old replica;
* restart keeps both in-flight requests and parked cutovers; interleaved
  request/migration decisions still cut over only once.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))

from app.main import create_app  # noqa: E402


def _client(db: Path) -> TestClient:
    return TestClient(create_app(db))


def _topo(
    nodes: list[dict] | None = None,
    containers: list[dict] | None = None,
) -> dict:
    return {
        "nodes": nodes
        or [
            {"id": "n1", "cpu_capacity": 8},
            {"id": "n2", "cpu_capacity": 8},
        ],
        "containers": containers
        or [
            {"id": "c1", "service": "svc", "min_ready": 1, "node_id": "n1", "cpu_request": 2},
        ],
    }


def _submit(client: TestClient, service: str = "svc") -> dict:
    return client.post("/api/requests", json={"service": service}).json()


def _latest_request(state: dict) -> dict:
    return state["requests"][0]


def test_request_is_pinned_to_one_serving_replica(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        state = _submit(client)
        req = _latest_request(state)
        assert req["status"] == "running"
        assert req["container_id"] == "c1"
        assert req["node_id"] == "n1"
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["active_request"]["id"] == req["id"]
        assert c1["accepting_requests"] is False
        n1 = next(n for n in state["nodes"] if n["id"] == "n1")
        assert n1["running_requests"] == 1


def test_one_replica_handles_one_request_at_a_time(tmp_path):
    topo = _topo(
        containers=[
            {"id": "c1", "service": "svc", "min_ready": 1, "node_id": "n1", "cpu_request": 2},
            {"id": "c2", "service": "svc", "min_ready": 1, "node_id": "n2", "cpu_request": 2},
        ]
    )
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=topo)
        first = _latest_request(_submit(client))
        second = _latest_request(_submit(client))
        assert {first["container_id"], second["container_id"]} == {"c1", "c2"}
        # Both replicas busy -> explicit rejection.
        rejected = _latest_request(_submit(client))
        assert rejected["status"] == "rejected"
        assert rejected["note"].startswith("REPLICA_BUSY")


def test_unknown_service_is_404(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        resp = client.post("/api/requests", json={"service": "nope"})
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "SERVICE_NOT_FOUND"


def test_draining_old_replica_refuses_new_request(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        state = client.post("/api/nodes/n1/drain").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]
        # Only replica c1 is on the draining source node.
        rejected = _latest_request(_submit(client))
        assert rejected["status"] == "rejected"
        assert rejected["note"].startswith("SERVICE_DRAINING")

        # Even while the new replica is still starting, refusal persists.
        assert mid
        rejected2 = _latest_request(_submit(client))
        assert rejected2["status"] == "rejected"


def test_ready_replica_parks_when_request_in_flight_without_early_progress(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        rid = _latest_request(_submit(client))["id"]
        state = client.post("/api/nodes/n1/drain").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]

        state = client.post(
            f"/api/migrations/{mid}/resolve", json={"outcome": "ready"}
        ).json()
        drain = state["open_drains"][0]
        assert drain["awaiting_cutover"] == 1
        assert drain["starting"] == 0
        assert drain["moved"] == 0
        assert drain["remaining_on_node"] == 1
        assert drain["progress_percent"] == 0.0
        # Old replica still serving on n1; target keeps the reservation.
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["node_id"] == "n1"
        n1 = next(n for n in state["nodes"] if n["id"] == "n1")
        n2 = next(n for n in state["nodes"] if n["id"] == "n2")
        assert n1["serving_containers"] == 1
        assert n2["reserved_cpu"] == 2 and n2["used_cpu"] == 2
        # Ready count for the service did not change.
        svc = next(s for s in state["services"] if s["name"] == "svc")
        assert svc["ready"] == 1 and svc["awaiting_cutover_replicas"] == 1
        # Node is not empty and drain stays active.
        assert n1["is_empty"] is False
        assert drain["status"] == "active"
        # The parked replica refuses new work too.
        rejected = _latest_request(_submit(client))
        assert rejected["status"] == "rejected"
        assert rejected["note"].startswith(("REPLICA_PARKED", "SERVICE_DRAINING"))


def test_request_completion_fires_the_single_cutover(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        rid = _latest_request(_submit(client))["id"]
        state = client.post("/api/nodes/n1/drain").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]
        client.post(f"/api/migrations/{mid}/resolve", json={"outcome": "ready"})

        state = client.post(
            f"/api/requests/{rid}/complete", json={"result": "200 OK"}
        ).json()
        assert state["open_drains"] == []
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["node_id"] == "n2"
        n1 = next(n for n in state["nodes"] if n["id"] == "n1")
        assert n1["is_empty"] is True
        request = next(r for r in state["requests"] if r["id"] == rid)
        assert request["status"] == "completed"
        assert request["cutover_migration_id"] == mid
        assert request["result"] == "200 OK"
        # Target reservation converted into serving usage.
        n2 = next(n for n in state["nodes"] if n["id"] == "n2")
        assert n2["serving_cpu"] == 2 and n2["reserved_cpu"] == 0

        # Idempotency guards: neither the migration nor request can move twice.
        again_migration = client.post(
            f"/api/migrations/{mid}/resolve", json={"outcome": "ready"}
        )
        assert again_migration.status_code == 409
        again_request = client.post(f"/api/requests/{rid}/complete")
        assert again_request.status_code == 409


def test_failed_start_releases_reservation_and_request_completes(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        rid = _latest_request(_submit(client))["id"]
        state = client.post("/api/nodes/n1/drain").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]
        state = client.post(
            f"/api/migrations/{mid}/resolve", json={"outcome": "failed"}
        ).json()
        n2 = next(n for n in state["nodes"] if n["id"] == "n2")
        assert n2["reserved_cpu"] == 0 and n2["remaining_cpu"] == 8
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["node_id"] == "n1"
        assert state["open_drains"][0]["status"] == "incomplete"

        # The original in-flight request still finishes on the old replica.
        state = client.post(f"/api/requests/{rid}/complete").json()
        request = next(r for r in state["requests"] if r["id"] == rid)
        assert request["status"] == "completed"
        assert request["cutover_migration_id"] is None
        c1 = next(c for c in state["containers"] if c["id"] == "c1")
        assert c1["node_id"] == "n1"


def test_interleaved_requests_each_cut_over_once(tmp_path):
    topo = _topo(
        containers=[
            {"id": "c1", "service": "a", "min_ready": 1, "node_id": "n1", "cpu_request": 2},
            {"id": "c2", "service": "b", "min_ready": 1, "node_id": "n1", "cpu_request": 2},
        ]
    )
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=topo)
        r1 = _latest_request(_submit(client, "a"))["id"]
        r2 = _latest_request(_submit(client, "b"))["id"]
        state = client.post("/api/nodes/n1/drain").json()
        mids = {
            m["container_id"]: m["id"]
            for m in state["open_drains"][0]["pending_decisions"]
        }
        client.post(f"/api/migrations/{mids['c1']}/resolve", json={"outcome": "ready"})
        client.post(f"/api/migrations/{mids['c2']}/resolve", json={"outcome": "ready"})

        state = client.post(f"/api/requests/{r1}/complete").json()
        drain = state["open_drains"][0]
        assert drain["moved"] == 1
        assert drain["awaiting_cutover"] == 1
        assert drain["remaining_on_node"] == 1
        assert next(c for c in state["containers"] if c["id"] == "c1")["node_id"] == "n2"
        assert next(c for c in state["containers"] if c["id"] == "c2")["node_id"] == "n1"

        state = client.post(f"/api/requests/{r2}/complete").json()
        assert state["open_drains"] == []
        reqs = {r["id"]: r for r in state["requests"]}
        assert reqs[r1]["cutover_migration_id"] == mids["c1"]
        assert reqs[r2]["cutover_migration_id"] == mids["c2"]
        # Each migration row completed exactly once.
        assert all(
            m["state"] == "completed"
            for drain in state["drains"]
            for m in drain["attempts"]
        )


def test_restart_resumes_in_flight_request_and_parked_cutover(tmp_path):
    db = tmp_path / "restart.db"
    with _client(db) as client:
        client.post("/api/topology", json=_topo())
        rid = _latest_request(_submit(client))["id"]
        state = client.post("/api/nodes/n1/drain").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]
        client.post(f"/api/migrations/{mid}/resolve", json={"outcome": "ready"})

    with _client(db) as reopened:
        state = reopened.get("/api/state").json()
        assert state["running_request_count"] == 1
        assert state["open_drains"][0]["awaiting_cutover"] == 1
        n2 = next(n for n in state["nodes"] if n["id"] == "n2")
        assert n2["reserved_cpu"] == 2
        n1 = next(n for n in state["nodes"] if n["id"] == "n1")
        assert n1["serving_containers"] == 1

        state = reopened.post(f"/api/requests/{rid}/complete").json()
        assert state["open_drains"] == []
        assert next(c for c in state["containers"] if c["id"] == "c1")["node_id"] == "n2"
        request = next(r for r in state["requests"] if r["id"] == rid)
        assert request["cutover_migration_id"] == mid


def test_restart_resumes_plain_running_request(tmp_path):
    db = tmp_path / "restart2.db"
    with _client(db) as client:
        client.post("/api/topology", json=_topo())
        rid = _latest_request(_submit(client))["id"]

    with _client(db) as reopened:
        state = reopened.get("/api/state").json()
        assert state["running_request_count"] == 1
        state = reopened.post(f"/api/requests/{rid}/complete").json()
        request = next(r for r in state["requests"] if r["id"] == rid)
        assert request["status"] == "completed"
        assert request["cutover_migration_id"] is None


def test_no_accepting_replica_is_rejected_explicitly(tmp_path):
    # The service's only replica starts with no ready peer; once its node is
    # draining there is nowhere to accept a new request.
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        client.post("/api/nodes/n1/drain")
        rejected = _latest_request(_submit(client))
        assert rejected["status"] == "rejected"
        assert rejected["container_id"] is None and rejected["node_id"] is None
        assert "note" in rejected and rejected["note"]


def test_replica_becomes_available_again_after_request_completes(tmp_path):
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=_topo())
        rid = _latest_request(_submit(client))["id"]
        # While busy, a second request is rejected.
        assert _latest_request(_submit(client))["status"] == "rejected"
        client.post(f"/api/requests/{rid}/complete")
        # The replica is free again and accepts new work.
        accepted = _latest_request(_submit(client))
        assert accepted["status"] == "running"
        assert accepted["container_id"] == "c1"


def test_request_on_parked_replica_waits_and_drain_keeps_reservation(tmp_path):
    topo = _topo(
        containers=[
            {"id": "c1", "service": "svc", "min_ready": 1, "node_id": "n1", "cpu_request": 2},
            {"id": "c2", "service": "other", "min_ready": 1, "node_id": "n2", "cpu_request": 2},
        ]
    )
    with _client(tmp_path / "r.db") as client:
        client.post("/api/topology", json=topo)
        rid = _latest_request(_submit(client, "svc"))["id"]
        state = client.post("/api/nodes/n1/drain").json()
        mid = state["open_drains"][0]["pending_decisions"][0]["id"]
        client.post(f"/api/migrations/{mid}/resolve", json={"outcome": "ready"})

        # A second service on the target node still works: its replica is free.
        other = _latest_request(_submit(client, "other"))
        assert other["status"] == "running" and other["container_id"] == "c2"

        state = client.get("/api/state").json()
        n2 = next(n for n in state["nodes"] if n["id"] == "n2")
        # Reservation for c1 plus serving c2.
        assert n2["reserved_cpu"] == 2 and n2["serving_cpu"] == 2
        client.post(f"/api/requests/{other['id']}/complete")

        state = client.post(f"/api/requests/{rid}/complete").json()
        assert state["open_drains"] == []
        n2 = next(n for n in state["nodes"] if n["id"] == "n2")
        assert n2["serving_cpu"] == 4 and n2["reserved_cpu"] == 0


@pytest.mark.parametrize("seed", [7])
def test_concurrent_request_submissions_never_double_book_replica(tmp_path, seed):
    """Two simultaneous submissions cannot pin one replica twice.

    The partial unique index ``idx_one_running_request_per_container`` plus the
    write lock make the loser fall through to another replica or a rejection.
    """
    import concurrent.futures

    db = tmp_path / "concurrent-requests.db"
    topo = _topo(
        containers=[
            {"id": "c1", "service": "svc", "min_ready": 1, "node_id": "n1", "cpu_request": 2},
            {"id": "c2", "service": "svc", "min_ready": 1, "node_id": "n2", "cpu_request": 2},
        ]
    )
    with _client(db) as client:
        client.post("/api/topology", json=topo)

    def submit(_: int) -> dict:
        with _client(db) as other:
            return other.post("/api/requests", json={"service": "svc"}).json()

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(submit, range(4)))
    with _client(db) as client:
        state = client.get("/api/state").json()
    running = [r for r in state["requests"] if r["status"] == "running"]
    rejected = [r for r in state["requests"] if r["status"] == "rejected"]
    assert len(running) == 2
    assert {r["container_id"] for r in running} == {"c1", "c2"}
    assert len(rejected) == 2
    # No replica ever holds more than one running request.
    counts: dict[str, int] = {}
    for r in running:
        counts[r["container_id"]] = counts.get(r["container_id"], 0) + 1
    assert all(count == 1 for count in counts.values())
