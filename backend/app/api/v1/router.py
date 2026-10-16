"""Aggregates the /api/v1 routers. Feature routers register here as they land."""

from fastapi import APIRouter

from app.api.v1 import join, people

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(join.router)
api_router.include_router(people.router)
