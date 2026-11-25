"""The Lotería deck (ADR-0018 amendment 2026-11-26): 54 cards, ids 1-54, traditional order.

Pure data. The picture is a large emoji (no copyrighted artwork); the Spanish name carries the
meaning and is what screen readers get. The frontend mirrors this table in
`frontend/src/lib/loteria-deck.ts`, and `tests/unit/test_games_loteria.py` pins the two equal.
Some traditional names are dated; rename or drop them here, in one place.
"""

from __future__ import annotations

from typing import NamedTuple


class Card(NamedTuple):
    id: int
    name_es: str
    name_en: str
    emoji: str


DECK: tuple[Card, ...] = (
    Card(1, "El Gallo", "The Rooster", "🐓"),
    Card(2, "El Diablito", "The Little Devil", "😈"),
    Card(3, "La Dama", "The Lady", "💃"),
    Card(4, "El Catrín", "The Dandy", "🎩"),
    Card(5, "El Paraguas", "The Umbrella", "☂️"),
    Card(6, "La Sirena", "The Mermaid", "🧜‍♀️"),
    Card(7, "La Escalera", "The Ladder", "🪜"),
    Card(8, "La Botella", "The Bottle", "🍾"),
    Card(9, "El Barril", "The Barrel", "🛢️"),
    Card(10, "El Árbol", "The Tree", "🌳"),
    Card(11, "El Melón", "The Melon", "🍈"),
    Card(12, "El Valiente", "The Brave One", "💪"),
    Card(13, "El Gorrito", "The Little Bonnet", "🧢"),
    Card(14, "La Muerte", "Death", "💀"),
    Card(15, "La Pera", "The Pear", "🍐"),
    Card(16, "La Bandera", "The Flag", "🚩"),
    Card(17, "El Bandolón", "The Mandolin", "🎸"),
    Card(18, "El Violoncello", "The Cello", "🎻"),
    Card(19, "La Garza", "The Heron", "🦩"),
    Card(20, "El Pájaro", "The Bird", "🐦"),
    Card(21, "La Mano", "The Hand", "✋"),
    Card(22, "La Bota", "The Boot", "🥾"),
    Card(23, "La Luna", "The Moon", "🌙"),
    Card(24, "El Cotorro", "The Parrot", "🦜"),
    Card(25, "El Borracho", "The Drunkard", "🥴"),
    Card(26, "El Negrito", "The Little Black Man", "🧑🏿"),
    Card(27, "El Corazón", "The Heart", "❤️"),
    Card(28, "La Sandía", "The Watermelon", "🍉"),
    Card(29, "El Tambor", "The Drum", "🥁"),
    Card(30, "El Camarón", "The Shrimp", "🦐"),
    Card(31, "Las Jaras", "The Arrows", "🏹"),
    Card(32, "El Músico", "The Musician", "🎺"),
    Card(33, "La Araña", "The Spider", "🕷️"),
    Card(34, "El Soldado", "The Soldier", "💂"),
    Card(35, "La Estrella", "The Star", "⭐"),
    Card(36, "El Cazo", "The Ladle", "🍲"),
    Card(37, "El Mundo", "The World", "🌎"),
    Card(38, "El Apache", "The Apache", "🪶"),
    Card(39, "El Nopal", "The Prickly Pear Cactus", "🌵"),
    Card(40, "El Alacrán", "The Scorpion", "🦂"),
    Card(41, "La Rosa", "The Rose", "🌹"),
    Card(42, "La Calavera", "The Skull", "☠️"),
    Card(43, "La Campana", "The Bell", "🔔"),
    Card(44, "El Cantarito", "The Little Water Pitcher", "🏺"),
    Card(45, "El Venado", "The Deer", "🦌"),
    Card(46, "El Sol", "The Sun", "☀️"),
    Card(47, "La Corona", "The Crown", "👑"),
    Card(48, "La Chalupa", "The Canoe", "🛶"),
    Card(49, "El Pino", "The Pine", "🌲"),
    Card(50, "El Pescado", "The Fish", "🐟"),
    Card(51, "La Palma", "The Palm", "🌴"),
    Card(52, "La Maceta", "The Flowerpot", "🪴"),
    Card(53, "El Arpa", "The Harp", "🎼"),
    Card(54, "La Rana", "The Frog", "🐸"),
)

BY_ID: dict[int, Card] = {c.id: c for c in DECK}
