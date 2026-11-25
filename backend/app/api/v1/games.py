"""Games and the Gratitude Jar (ADR-0018, 03-backend.md "Games").

Hosts (`sessions:run`) create a game, start the reveal, show the next note, hide a note and
end it. A phone drops a note as a person bound to it. Any device or account reads the
snapshot, which never holds an unrevealed note or the author of an anonymous one.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, status

from app.api.v1.sessions import NOT_FOUND, raise_http, tie_seed
from app.core.dependencies import (
    AccountContext,
    AccountDb,
    CsrfProtected,
    CurrentDevice,
    CurrentViewer,
    DeviceDb,
    ViewerDb,
    require_permission,
)
from app.schemas.games import (
    GameCreateIn,
    GameOut,
    GameSummaryOut,
    JarAuthorOut,
    JarNoteOut,
    JarOut,
    ModerationNoteOut,
    NoteIn,
    OwnNoteOut,
    ScatterAnswerOut,
    ScatterOut,
    ScatterPlayerOut,
    ScatterRevealedOut,
    ScatterRoundOut,
    ScatterScoreOut,
    ScatterStandingOut,
)
from app.services import games_service, scatter_service
from app.services.errors import ServiceError

router = APIRouter(prefix="/games", tags=["games"])

CanHost = Annotated[AccountContext, Depends(require_permission("sessions:run"))]

HOST: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    409: {"description": "The game is not in a state that allows this"},
}
PLAYER: dict[int | str, dict[str, Any]] = {
    **HOST,
    403: {"description": "This phone isn't acting as that person, or consent is needed"},
}


def _author(a: games_service.Author | None) -> JarAuthorOut | None:
    return None if a is None else JarAuthorOut(**a.__dict__)


def _note(n: games_service.ShownNote) -> JarNoteOut:
    return JarNoteOut(id=n.id, body=n.body, author=_author(n.author), revealed_at=n.revealed_at)


def _summary(g: games_service.GameRow) -> GameSummaryOut:
    return GameSummaryOut(
        id=g.id,
        kind=g.kind,
        title=g.title,
        status=g.status,
        created_at=g.created_at,
    )


def _scatter(s: scatter_service.ScatterState) -> ScatterOut:
    return ScatterOut(
        server_now=s.server_now,
        current=None if s.current is None else ScatterRoundOut(**s.current.__dict__),
        players=[ScatterPlayerOut(**p.__dict__) for p in s.players],
        revealed=[
            ScatterRevealedOut(
                round_no=r.round_no,
                letter=r.letter,
                categories=r.categories,
                answers=[ScatterAnswerOut(**a.__dict__) for a in r.answers],
                scores=[ScatterScoreOut(person_id=k, points=v) for k, v in r.scores.items()],
            )
            for r in s.revealed
        ],
        leaderboard=[ScatterStandingOut(**t.__dict__) for t in s.leaderboard],
    )


def _out(
    game: games_service.GameRow,
    jar_state: games_service.JarState | None,
    scatter: ScatterOut | None = None,
) -> GameOut:
    return GameOut(
        **_summary(game).model_dump(),
        allow_anonymous=bool(game.config.get("allow_anonymous", True)),
        jar=None
        if jar_state is None
        else JarOut(
            note_count=jar_state.note_count,
            revealed_count=jar_state.revealed_count,
            remaining=jar_state.remaining,
            current=None if jar_state.current is None else _note(jar_state.current),
            revealed=[_note(n) for n in jar_state.revealed],
        ),
        scatter=scatter,
    )


async def _snapshot(db: Any, household_id: uuid.UUID, game_id: uuid.UUID) -> GameOut:
    try:
        game, jar_state = await games_service.snapshot(db, household_id, game_id)
        scatter = await scatter_service.state(db, game_id) if game.kind == "scattergories" else None
    except ServiceError as err:
        raise_http(err)
    return _out(game, jar_state, None if scatter is None else _scatter(scatter))


# Shared with the scattergories router.
snapshot = _snapshot


@router.get("", response_model=list[GameSummaryOut])
async def list_games(viewer: CurrentViewer, db: ViewerDb) -> list[GameSummaryOut]:
    """The household's games, newest first (any device or account)."""
    return [_summary(g) for g in await games_service.list_games(db, viewer.household_id)]


@router.post(
    "",
    response_model=GameOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses={422: {"description": "That game isn't available yet"}},
)
async def create_game(body: GameCreateIn, account: CanHost, db: AccountDb) -> GameOut:
    """Start a game (hosts). The jar and scattergories exist so far."""
    try:
        game = await games_service.create_game(
            db,
            account.household_id,
            account.account_id,
            kind=body.kind,
            title=body.title,
            allow_anonymous=body.allow_anonymous,
        )
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game.id)


@router.get("/{game_id}", response_model=GameOut, responses=NOT_FOUND)
async def get_game(game_id: uuid.UUID, viewer: CurrentViewer, db: ViewerDb) -> GameOut:
    """The snapshot: revealed notes only, never an anonymous note's author."""
    return await _snapshot(db, viewer.household_id, game_id)


@router.post(
    "/{game_id}/end",
    response_model=GameOut,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def end_game(game_id: uuid.UUID, account: CanHost, db: AccountDb) -> GameOut:
    """End the game (idempotent)."""
    try:
        await games_service.end_game(db, account.household_id, account.account_id, game_id)
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game_id)


# ---- Gratitude Jar ----


@router.post(
    "/{game_id}/jar/notes",
    response_model=OwnNoteOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def add_note(
    game_id: uuid.UUID, body: NoteIn, device: CurrentDevice, db: DeviceDb
) -> OwnNoteOut:
    """Drop a note as a person bound to this phone."""
    try:
        note = await games_service.add_note(
            db,
            device.household_id,
            game_id,
            device_id=device.device_id,
            person_id=body.person_id,
            body=body.body,
            anonymous=body.anonymous,
        )
    except ServiceError as err:
        raise_http(err)
    return OwnNoteOut(**note.__dict__)


@router.get("/{game_id}/jar/notes/mine", response_model=list[OwnNoteOut], responses=NOT_FOUND)
async def my_notes(game_id: uuid.UUID, device: CurrentDevice, db: DeviceDb) -> list[OwnNoteOut]:
    """Notes written by the people this phone is acting as."""
    try:
        notes = await games_service.own_notes(db, device.household_id, game_id, device.device_id)
    except ServiceError as err:
        raise_http(err)
    return [OwnNoteOut(**n.__dict__) for n in notes]


@router.delete(
    "/{game_id}/jar/notes/{note_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def delete_note(
    game_id: uuid.UUID, note_id: uuid.UUID, device: CurrentDevice, db: DeviceDb
) -> None:
    """Take your own note back until it has been shown."""
    try:
        await games_service.delete_own_note(
            db, device.household_id, game_id, note_id, device_id=device.device_id
        )
    except ServiceError as err:
        raise_http(err)


@router.get(
    "/{game_id}/jar/moderation", response_model=list[ModerationNoteOut], responses=NOT_FOUND
)
async def moderation(
    game_id: uuid.UUID, account: CanHost, db: AccountDb
) -> list[ModerationNoteOut]:
    """Every note with its text, for the host to hide before it shows. No author for an
    anonymous note."""
    try:
        notes = await games_service.moderation(db, account.household_id, game_id)
    except ServiceError as err:
        raise_http(err)
    return [
        ModerationNoteOut(
            id=n.id,
            body=n.body,
            anonymous=n.anonymous,
            author=_author(n.author),
            revealed_at=n.revealed_at,
            hidden_at=n.hidden_at,
        )
        for n in notes
    ]


@router.post(
    "/{game_id}/jar/notes/{note_id}/hide",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[CsrfProtected],
    responses=NOT_FOUND,
)
async def hide_note(
    game_id: uuid.UUID, note_id: uuid.UUID, account: CanHost, db: AccountDb
) -> None:
    """Hide a note from every screen (idempotent)."""
    try:
        await games_service.hide_note(
            db, account.household_id, account.account_id, game_id, note_id
        )
    except ServiceError as err:
        raise_http(err)


@router.post(
    "/{game_id}/jar/start-reveal",
    response_model=GameOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def start_reveal(
    game_id: uuid.UUID,
    account: CanHost,
    db: AccountDb,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> GameOut:
    """Stop taking notes and fix a shuffled order for the reveal."""
    try:
        await games_service.start_reveal(
            db, account.household_id, account.account_id, game_id, seed=tie_seed(x_fnh_test_seed)
        )
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/jar/reveal-next",
    response_model=GameOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def reveal_next(game_id: uuid.UUID, account: CanHost, db: AccountDb) -> GameOut:
    """Show the next note on the TV."""
    try:
        await games_service.reveal_next(db, account.household_id, account.account_id, game_id)
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game_id)
