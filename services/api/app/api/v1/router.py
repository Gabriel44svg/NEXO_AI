from fastapi import APIRouter

from app.api.v1.endpoints import health
from app.modules.organizations.router import router as organizations_router
from app.modules.auth.router import router as auth_router
from app.modules.authorization.router import router as authorization_router
from app.modules.tenancy.router import router as tenancy_router
from app.modules.products.router import router as products_router
from app.modules.materials.router import materials_router, recipe_router
from app.modules.capacity.router import router as capacity_router
from app.modules.orders.router import router as orders_router

api_router = APIRouter()
api_router.include_router(health.router)
# Route /organizations/me must precede the bootstrap /organizations/{id} route.
api_router.include_router(authorization_router)
api_router.include_router(organizations_router)
api_router.include_router(auth_router)
api_router.include_router(tenancy_router)
api_router.include_router(products_router)

api_router.include_router(materials_router)
api_router.include_router(recipe_router)
api_router.include_router(capacity_router)

from app.modules.order_search.router import router as order_search_router
api_router.include_router(order_search_router)  # RF-012: ruta estatica antes de /{order_id}
api_router.include_router(orders_router)
from app.modules.voice_notes.router import router as voice_notes_router
from app.modules.review.router import router as review_router
api_router.include_router(voice_notes_router)

api_router.include_router(review_router)

from app.modules.order_status.router import router as order_status_router
api_router.include_router(order_status_router)
