"""Aggregates the /api/v1 routers. Feature routers register here as they land."""

from fastapi import APIRouter

api_router = APIRouter(prefix="/api/v1")
