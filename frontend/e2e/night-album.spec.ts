import { apiFromPhone, expectNoAxeViolations, joinAs } from "./support/phones";
import { addPhotos, type AlbumPhoto, JPEG_FIXTURE } from "./support/photos";
import { expect, seedNight, test } from "./support/seed";

type NightAlbum = { id: string | null; photo_count: number; is_tonight: boolean };
type Reel = { items: { kind: string; id: string }[] };

/**
 * Night albums (ADR-0019) against the real API and a real S3 bucket (SeaweedFS): on a games-only
 * evening (the movie night never gets past its draft, so its own album never opens), a phone adds
 * a photo from the Games tab's "Tonight's album", sees it in the album, and the Night reel picks
 * it up.
 */
test.describe("night album", () => {
  test("a photo added on a games-only evening lands in tonight's album and the reel", async ({
    page,
  }) => {
    test.slow(); // a PIN (argon2id) and the photo pipeline
    const night = seedNight({ movies: 2 });
    await joinAs(page, night, ["Ava"]);

    // The movie night isn't open for photos: its own upload path says so.
    const refused = await apiFromPhone(page, "POST", `/sessions/${night.sessionId}/photos`, {
      person_id: "00000000-0000-4000-8000-000000000000",
    });
    expect([403, 409]).toContain(refused.status);

    await page.goto("/games");
    const card = page.getByTestId("tonight-album-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("tonight-album-count")).toHaveText("Add the first photo");
    await card.click();
    await expect(page).toHaveURL(/\/photos\/tonight$/);
    const screen = page.getByTestId("night-album-screen");
    await expect(screen).toHaveAttribute("data-tonight", "true");
    await expect(page.getByTestId("album-title")).toHaveText("Tonight's album");
    await expect(page.getByTestId("album-empty")).toBeVisible();
    await expectNoAxeViolations(page);

    await addPhotos(page, [JPEG_FIXTURE]);
    await expect(page.getByTestId("album-grid").getByRole("listitem")).toHaveCount(1);
    await expectNoAxeViolations(page);

    // The server filed it in tonight's album, with no movie night attached.
    const tonight = (await apiFromPhone(page, "GET", "/albums/tonight")).body as NightAlbum;
    expect(tonight.id).not.toBeNull();
    expect(tonight.photo_count).toBe(1);
    const photos = (await apiFromPhone(page, "GET", `/albums/${tonight.id}/photos`))
      .body as AlbumPhoto[];
    expect(photos.map((p) => p.person_name)).toEqual(["Ava"]);
    const moviePhotos = (await apiFromPhone(page, "GET", `/sessions/${night.sessionId}/photos`))
      .body as AlbumPhoto[];
    expect(moviePhotos).toEqual([]);

    // The album list and Home show it.
    await page.goto("/photos");
    await expect(page.getByTestId("tonight-album-count")).toHaveText("1 photo");

    // The TV gets photos through the Night reel (owner answer 4): the photo is one of its slides.
    const reel = (await apiFromPhone(page, "GET", "/reel")).body as Reel;
    expect(reel.items.filter((i) => i.kind === "photo").map((i) => i.id)).toContain(
      `photo:${photos[0].id}`,
    );
  });
});
