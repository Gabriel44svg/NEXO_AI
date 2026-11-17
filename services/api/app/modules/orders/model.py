"""RF-008: borrador de pedido vinculado de manera fuerte a usuario y tenant."""
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index,
    String, UniqueConstraint, Uuid, func, text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        ForeignKeyConstraint(
            ["created_by_user_id", "organization_id"],
            ["users.id", "users.organization_id"],
            name="fk_orders_creator_tenant", ondelete="CASCADE",
        ),
        CheckConstraint("length(trim(raw_text)) > 0", name="ck_orders_raw_text_not_empty"),
        CheckConstraint("length(raw_text) <= 5000", name="ck_orders_raw_text_max_length"),
        CheckConstraint("status IN ('draft', 'pending', 'confirmed', 'in_progress', 'completed', 'cancelled')",
                        name="ck_orders_valid_status"),
        CheckConstraint("source IN ('manual', 'audio')", name="ck_orders_valid_source"),
        Index("ix_orders_org_created", "organization_id", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid4)
    organization_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    created_by_user_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    raw_text: Mapped[str] = mapped_column(String(5000), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default=text("'draft'"))
    source: Mapped[str] = mapped_column(String(20), nullable=False, server_default=text("'manual'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
