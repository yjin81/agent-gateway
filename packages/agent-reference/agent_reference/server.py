"""server.py — FastAPI server exposing POST /run for the reference agent."""

from __future__ import annotations

import uvicorn
from fastapi import FastAPI, HTTPException

from agent_gateway.types import AgentRequest, AgentResponse
from .agent import run_agent

app = FastAPI(title="Agent Reference", version="0.1.0")


@app.post("/run", response_model=AgentResponse)
async def run(request: AgentRequest) -> AgentResponse:
    """Process one agent turn."""
    try:
        text = await run_agent(
            session_key=request.session_key,
            message=request.message,
            is_new=request.is_new,
            was_auto_reset=request.was_auto_reset,
        )
        return AgentResponse(text=text, media=[], interrupted=False)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
