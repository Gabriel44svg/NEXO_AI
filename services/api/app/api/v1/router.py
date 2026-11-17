from fastapi import APIRouter

from app.api.v1.endpoints import health
from app.modules.organizations.router import router as organizations_router
from app.modules.auth.router import router as auth_router
from app.modules.authorization.router import router as authorization_router
from app.modules.tenancy.router import router as tenancy_router

api_router = APIRouter()
api_router.include_router(health.router)
# Route /organizations/me must precede the bootstrap /organizations/{id} route.
api_router.include_router(authorization_router)
api_router.include_router(organizations_router)
api_router.include_router(auth_router)
api_router.include_router(tenancy_router)
