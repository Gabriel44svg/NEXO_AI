"""RF-008: operacion de borradores restringida por organizacion y autor."""
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.orders.model import Order
from app.modules.orders.schemas import OrderCreate, OrderPatch
from app.modules.tenancy.scope import TenantScope


def get_order(db: Session, scope: TenantScope, order_id: UUID, *, lock: bool = False) -> Order:
    stmt = select(Order).where(Order.id == order_id, Order.organization_id == scope.organization_id)
    if lock:
        stmt = stmt.with_for_update()
    order = db.scalar(stmt)
    if order is None:
        raise HTTPException(status_code=404, detail="Solicitud no encontrada")
    return order


def list_orders(db: Session, scope: TenantScope, *, only_mine: bool, limit: int, offset: int) -> list[Order]:
    stmt = select(Order).where(Order.organization_id == scope.organization_id)
    if only_mine:
        stmt = stmt.where(Order.created_by_user_id == scope.actor_id)
    return list(db.scalars(stmt.order_by(Order.created_at.desc(), Order.id.desc())
                           .limit(limit).offset(offset)).all())


def create_order(db: Session, scope: TenantScope, payload: OrderCreate) -> Order:
    order = Order(
        organization_id=scope.organization_id, created_by_user_id=scope.actor_id,
        raw_text=payload.raw_text, status="draft", source="manual",
    )
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


def patch_order(db: Session, scope: TenantScope, order_id: UUID,
                payload: OrderPatch, *, role: str) -> Order:
    order = get_order(db, scope, order_id, lock=True)
    if order.status != "draft":
        raise HTTPException(status_code=409, detail="Solo se pueden editar borradores")
    if role != "owner" and order.created_by_user_id != scope.actor_id:
        raise HTTPException(status_code=403, detail="Solo puedes editar tus propias solicitudes")
    # Cambiar la solicitud invalida cualquier revision anterior.
    order.raw_text = payload.raw_text
    order.suggested_quantity = None
    order.suggested_due_date = None
    order.reviewed_quantity = None
    order.reviewed_due_date = None
    order.reviewed_by_user_id = None
    order.reviewed_at = None
    order.review_revision += 1
    db.commit()
    db.refresh(order)
    return order
