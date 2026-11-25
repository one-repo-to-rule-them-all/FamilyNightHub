"""Games and the Gratitude Jar (ADR-0018, 03-backend.md "Games").

Hosts (`sessions:run`) create a game, start the reveal, show the next note, hide a note and
end it. A phone drops a note as a person bound to it. Any device or account reads the
snapshot, which never holds an unrevealed note or the author of an anonymous one.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Path, Query, status

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
    BingoCallOut,
    BingoCardOut,
    BingoCheckIn,
    BingoCheckOut,
    BingoDrawIn,
    BingoJoinIn,
    BingoOut,
    BingoPlayerOut,
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
    TvTargetIn,
    TvTargetOut,
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
    bingo_state: games_service.BingoState | None = None,
    scatter: ScatterOut | None = None,
) -> GameOut:
    return GameOut(
        **_summary(game).model_dump(),
        allow_anonymous=bool(game.config.get("allow_anonymous", True)),
        bingo=None
        if bingo_state is None
        else BingoOut(
            mode="classic" if bingo_state.mode == "classic" else "thanksgiving",
            calls=[BingoCallOut(**c.__dict__) for c in bingo_state.calls],
            last_call=None
            if not bingo_state.calls
            else BingoCallOut(**bingo_state.calls[-1].__dict__),
            win_mode="blackout" if bingo_state.win_mode == "blackout" else "line",
            free_center=bingo_state.free_center,
            end_on_first_win=bingo_state.end_on_first_win,
            players=[BingoPlayerOut(**p.__dict__) for p in bingo_state.players],
        ),
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
        game, jar_state, bingo_state = await games_service.snapshot(db, household_id, game_id)
        scatter = await scatter_service.state(db, game_id) if game.kind == "scattergories" else None
    except ServiceError as err:
        raise_http(err)
    return _out(game, jar_state, bingo_state, None if scatter is None else _scatter(scatter))


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
    """Create a game (hosts): a jar opens at once; bingo and scattergories start as drafts."""
    try:
        game = await games_service.create_game(
            db,
            account.household_id,
            account.account_id,
            kind=body.kind,
            title=body.title,
            allow_anonymous=body.allow_anonymous,
            win_mode=body.win_mode,
            free_center=body.free_center,
            end_on_first_win=body.end_on_first_win,
            mode=body.mode,
        )
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game.id)


@router.get("/tv-target", response_model=TvTargetOut)
async def get_tv_target(viewer: CurrentViewer, db: ViewerDb) -> TvTargetOut:
    """The game a host sent to the paired TV, if any (any device or account). The TV polls
    this snapshot and follows it; there is no event to miss."""
    return TvTargetOut(game_id=await games_service.tv_target(db, viewer.household_id))


@router.put(
    "/tv-target",
    response_model=TvTargetOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def put_tv_target(body: TvTargetIn, account: CanHost, db: AccountDb) -> TvTargetOut:
    """Show a game on the paired TV, or (null) send the TV back to its QR home (hosts)."""
    try:
        target = await games_service.set_tv_target(
            db, account.household_id, account.account_id, body.game_id
        )
    except ServiceError as err:
        raise_http(err)
    return TvTargetOut(game_id=target)


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


# ---- Thanksgiving Bingo ----


@router.post(
    "/{game_id}/open", response_model=GameOut, dependencies=[CsrfProtected], responses=HOST
)
async def open_game(
    game_id: uuid.UUID,
    account: CanHost,
    db: AccountDb,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> GameOut:
    """Let the family join (draft to open). A classic game fixes its draw seed here."""
    try:
        await games_service.open_game(
            db, account.household_id, account.account_id, game_id, seed=tie_seed(x_fnh_test_seed)
        )
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/start", response_model=GameOut, dependencies=[CsrfProtected], responses=HOST
)
async def start_round(game_id: uuid.UUID, account: CanHost, db: AccountDb) -> GameOut:
    """Start the round: squares can be marked (open to live)."""
    try:
        await games_service.start_round(db, account.household_id, account.account_id, game_id)
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/bingo/join",
    response_model=BingoCardOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def join_bingo(
    game_id: uuid.UUID,
    body: BingoJoinIn,
    device: CurrentDevice,
    db: DeviceDb,
    x_fnh_test_seed: Annotated[str | None, Header(include_in_schema=False)] = None,
) -> BingoCardOut:
    """Take a seat as a person bound to this phone and get a card (idempotent)."""
    try:
        card = await games_service.join(
            db,
            device.household_id,
            game_id,
            device_id=device.device_id,
            person_id=body.person_id,
            seed=tie_seed(x_fnh_test_seed),
        )
    except ServiceError as err:
        raise_http(err)
    return BingoCardOut(**card.__dict__)


@router.get("/{game_id}/bingo/mine", response_model=list[BingoCardOut], responses=NOT_FOUND)
async def my_cards(game_id: uuid.UUID, device: CurrentDevice, db: DeviceDb) -> list[BingoCardOut]:
    """The cards of the people this phone is acting as. Nobody else's card is readable."""
    try:
        cards = await games_service.my_cards(db, device.household_id, game_id, device.device_id)
    except ServiceError as err:
        raise_http(err)
    return [BingoCardOut(**c.__dict__) for c in cards]


async def _mark(
    game_id: uuid.UUID, index: int, person_id: uuid.UUID, device: Any, db: Any, marked: bool
) -> BingoCardOut:
    try:
        card = await games_service.set_mark(
            db,
            device.household_id,
            game_id,
            index,
            device_id=device.device_id,
            person_id=person_id,
            marked=marked,
        )
    except ServiceError as err:
        raise_http(err)
    return BingoCardOut(**card.__dict__)


Square = Annotated[int, Path(ge=0, le=24)]


@router.put(
    "/{game_id}/bingo/mark/{index}",
    response_model=BingoCardOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def mark_square(
    game_id: uuid.UUID,
    index: Square,
    person_id: Annotated[uuid.UUID, Query()],
    device: CurrentDevice,
    db: DeviceDb,
) -> BingoCardOut:
    """Mark a square on your own card. Thanksgiving: the mark that completes the pattern is the
    win. Classic: only a called number can be marked (409), and only a host check wins."""
    return await _mark(game_id, index, person_id, device, db, True)


@router.delete(
    "/{game_id}/bingo/mark/{index}",
    response_model=BingoCardOut,
    dependencies=[CsrfProtected],
    responses=PLAYER,
)
async def unmark_square(
    game_id: uuid.UUID,
    index: Square,
    person_id: Annotated[uuid.UUID, Query()],
    device: CurrentDevice,
    db: DeviceDb,
) -> BingoCardOut:
    """Take a mark back. A win already recorded stays."""
    return await _mark(game_id, index, person_id, device, db, False)


# ---- Classic bingo: the host's draw and check ----


@router.post(
    "/{game_id}/bingo/draw",
    response_model=GameOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def draw_number(
    game_id: uuid.UUID, body: BingoDrawIn, account: CanHost, db: AccountDb
) -> GameOut:
    """Call the next number (hosts). `expected_seq` is the count the host's screen showed; a
    different count is 409 so a double tap or a second window cannot draw twice."""
    try:
        await games_service.draw(
            db, account.household_id, account.account_id, game_id, expected_seq=body.expected_seq
        )
    except ServiceError as err:
        raise_http(err)
    return await _snapshot(db, account.household_id, game_id)


@router.post(
    "/{game_id}/bingo/check",
    response_model=BingoCheckOut,
    dependencies=[CsrfProtected],
    responses=HOST,
)
async def check_bingo(
    game_id: uuid.UUID, body: BingoCheckIn, account: CanHost, db: AccountDb
) -> BingoCheckOut:
    """Verify a player's spoken "bingo" against the called numbers (hosts). A false claim
    changes nothing; a true one records the win and, by config, ends the game."""
    try:
        result = await games_service.check(
            db, account.household_id, account.account_id, game_id, person_id=body.person_id
        )
    except ServiceError as err:
        raise_http(err)
    return BingoCheckOut(
        valid=result.valid,
        win_mode="blackout" if result.win_mode == "blackout" else "line",
        pattern=result.pattern,
        missing=result.missing,
    )
