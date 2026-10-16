"""Aggregates the /api/v1 routers. Feature routers register here as they land."""

from fastapi import APIRouter

from app.api.v1 import auth, device_admin, join, people

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(device_admin.router)
api_router.include_router(join.router)
api_router.include_router(people.router)
