/**
 * What a game route shows while the game's kind is still unknown. It makes no game-specific
 * request, so a bingo round never briefly mounts the jar's screens.
 */
export function GameLoading() {
  return (
    <p
      role="status"
      data-testid="game-loading"
      className="m-auto p-6 text-center text-muted-foreground"
    >
      Loading…
    </p>
  );
}
