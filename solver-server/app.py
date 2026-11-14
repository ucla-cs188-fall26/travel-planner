"""Local-only API; no Firebase client, credentials, or write/apply route."""
from threading import Lock

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from models import SolveRequest
from planner import load_catalog, public_catalog, solve

app = FastAPI(title="Travel constraint solver", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
# Z3's default context is not safe for simultaneous use from worker threads.
# A small, local demo serializes bounded calls rather than sharing live solvers.
_solve_lock = Lock()


@app.get("/solver-api/health")
def health():
    return {"ok": True}


@app.get("/solver-api/catalog")
def catalog():
    return public_catalog(load_catalog())


@app.post("/solver-api/solve")
def solve_trip(request: SolveRequest):
    with _solve_lock:
        return solve(request)
