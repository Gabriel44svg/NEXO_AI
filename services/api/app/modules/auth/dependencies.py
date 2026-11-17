"""Valida firma JWT, organizacion, estado de usuario y revocacion en DB."""
from dataclasses import dataclass
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.modules.auth.model import AuthSession, User
from app.modules.auth.security import as_utc, decode_access_token, utc_now

bearer = HTTPBearer(auto_error=False)


@dataclass
class AuthContext:
    user: User
    session: AuthSession


def get_auth_context(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> AuthContext:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Se requiere Bearer token", headers={"WWW-Authenticate": "Bearer"})
    claims = decode_access_token(credentials.credentials)
    try:
        user_id = UUID(claims["sub"])
        organization_id = UUID(claims["org"])
        session_id = UUID(claims["jti"])
    except (TypeError, ValueError, KeyError) as exc:
        raise HTTPException(status_code=401, detail="Token invalido") from exc
    user = db.get(User, user_id)
    session = db.get(AuthSession, session_id)
    if (
        user is None or not user.is_active or user.organization_id != organization_id
        or session is None or session.user_id != user_id
        or session.revoked_at is not None or as_utc(session.expires_at) <= utc_now()
    ):
        raise HTTPException(status_code=401, detail="Sesion invalida o revocada")
    return AuthContext(user=user, session=session)
