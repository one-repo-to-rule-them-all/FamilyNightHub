"""Aggregates the /api/v1 routers. Feature routers register here as they land."""

from fastapi import APIRouter

from app.api.v1 import (
    admin,
    auth,
    ballots,
    device_admin,
    join,
    people,
    photos,
    sessions,
    stream,
    tmdb,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(admin.router)
api_router.include_router(auth.router)
api_router.include_router(ballots.router)
api_router.include_router(device_admin.router)
api_router.include_router(join.router)
api_router.include_router(people.router)
api_router.include_router(photos.router)
api_router.include_router(sessions.router)
api_router.include_router(stream.router)
api_router.include_router(tmdb.router)
