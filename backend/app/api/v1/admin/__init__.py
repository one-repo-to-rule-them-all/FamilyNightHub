"""The admin area, `/api/v1/admin/*` (03-backend.md "Admin"). Account-authenticated only:
a device cookie alone gets 401, a role without the permission 403, and another
household's id 404. Every mutation is CSRF-protected and writes an audit row."""

from fastapi import APIRouter

from app.api.v1.admin import devices, history, movies, people, settings

router = APIRouter(prefix="/admin")
router.include_router(people.router)
router.include_router(devices.router)
router.include_router(settings.router)
router.include_router(movies.router)
router.include_router(history.router)
