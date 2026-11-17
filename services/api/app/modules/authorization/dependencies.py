"""Guardias de roles del servidor; nunca confiar en roles enviados por el cliente."""
from collections.abc import Callable

from fastapi import Depends, HTTPException, status

from app.modules.auth.dependencies import AuthContext, get_auth_context

VALID_ROLES = frozenset({"owner", "operator"})


def require_roles(*roles: str) -> Callable:
    allowed = frozenset(roles)
    if not allowed or not allowed.issubset(VALID_ROLES):
        raise ValueError("Configuracion de permisos invalida")

    def check_role(context: AuthContext = Depends(get_auth_context)) -> AuthContext:
        if context.user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No tienes permiso para realizar esta operacion",
            )
        return context

    return check_role


require_owner = require_roles("owner")
require_staff = require_roles("owner", "operator")
