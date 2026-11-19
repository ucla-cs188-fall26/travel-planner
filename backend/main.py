"""Run from the repository root: python -m uvicorn backend.main:app --port 8000."""
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import llm, planner
from .schemas import ChangeRequest, ChangeResponse, ChatRequest, ChatResponse, Trip
from .solver import PlanningError

app = FastAPI(title='Travel Planner API', version='1.0.0')


@app.exception_handler(RequestValidationError)
async def invalid_request(_request, exc):
    # Avoid echoing whole input objects (including chat history) in validation errors.
    return JSONResponse(status_code=422, content={'detail': 'Invalid planner request.',
                                                 'errors': [{'field': list(e['loc']), 'message': e['msg']}
                                                            for e in exc.errors()]})


@app.exception_handler(PlanningError)
async def planning_error(_request, exc):
    return JSONResponse(status_code=503 if exc.timeout else 422,
                        content={'detail': str(exc), 'conflicts': exc.conflicts})


@app.exception_handler(llm.LLMError)
async def llm_error(_request, exc):
    return JSONResponse(status_code=502 if llm.configured() else 503, content={'detail': str(exc)})


@app.get('/api/health')
def health():
    return {'ok': True, 'llmConfigured': llm.configured(), 'planner': 'z3'}


@app.get('/api/trip', response_model=Trip, response_model_exclude_none=True)
def demo_trip():
    fixture = Path(__file__).resolve().parent.parent / 'shared/fixtures/mock-trip.json'
    return Trip.model_validate(json.loads(fixture.read_text()))


@app.post('/api/chat', response_model=ChatResponse, response_model_exclude_none=True)
def chat(request: ChatRequest):
    return planner.chat(request)


@app.post('/api/itinerary/change', response_model=ChangeResponse, response_model_exclude_none=True)
def change(request: ChangeRequest):
    return planner.change(request)
