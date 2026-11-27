// The Lotería deck (ADR-0018 amendment 2026-11-26): ids 1-54 in traditional order. Mirrors
// backend/app/domain/games/loteria_deck.py; tests/unit/test_games_loteria.py pins them equal.
// The picture is a large emoji (no copyrighted artwork); the Spanish name is what is read out.

export interface LoteriaCard {
  id: number;
  es: string;
  en: string;
  emoji: string;
}

export const DECK: readonly LoteriaCard[] = [
  { id: 1, es: "El Gallo", en: "The Rooster", emoji: "🐓" },
  { id: 2, es: "El Diablito", en: "The Little Devil", emoji: "😈" },
  { id: 3, es: "La Dama", en: "The Lady", emoji: "💃" },
  { id: 4, es: "El Catrín", en: "The Dandy", emoji: "🎩" },
  { id: 5, es: "El Paraguas", en: "The Umbrella", emoji: "☂️" },
  { id: 6, es: "La Sirena", en: "The Mermaid", emoji: "🧜‍♀️" },
  { id: 7, es: "La Escalera", en: "The Ladder", emoji: "🪜" },
  { id: 8, es: "La Botella", en: "The Bottle", emoji: "🍾" },
  { id: 9, es: "El Barril", en: "The Barrel", emoji: "🛢️" },
  { id: 10, es: "El Árbol", en: "The Tree", emoji: "🌳" },
  { id: 11, es: "El Melón", en: "The Melon", emoji: "🍈" },
  { id: 12, es: "El Valiente", en: "The Brave One", emoji: "💪" },
  { id: 13, es: "El Gorrito", en: "The Little Bonnet", emoji: "🧢" },
  { id: 14, es: "La Muerte", en: "Death", emoji: "💀" },
  { id: 15, es: "La Pera", en: "The Pear", emoji: "🍐" },
  { id: 16, es: "La Bandera", en: "The Flag", emoji: "🚩" },
  { id: 17, es: "El Bandolón", en: "The Mandolin", emoji: "🎸" },
  { id: 18, es: "El Violoncello", en: "The Cello", emoji: "🎻" },
  { id: 19, es: "La Garza", en: "The Heron", emoji: "🦩" },
  { id: 20, es: "El Pájaro", en: "The Bird", emoji: "🐦" },
  { id: 21, es: "La Mano", en: "The Hand", emoji: "✋" },
  { id: 22, es: "La Bota", en: "The Boot", emoji: "🥾" },
  { id: 23, es: "La Luna", en: "The Moon", emoji: "🌙" },
  { id: 24, es: "El Cotorro", en: "The Parrot", emoji: "🦜" },
  { id: 25, es: "El Borracho", en: "The Drunkard", emoji: "🥴" },
  { id: 26, es: "El Negrito", en: "The Little Black Man", emoji: "🧑🏿" },
  { id: 27, es: "El Corazón", en: "The Heart", emoji: "❤️" },
  { id: 28, es: "La Sandía", en: "The Watermelon", emoji: "🍉" },
  { id: 29, es: "El Tambor", en: "The Drum", emoji: "🥁" },
  { id: 30, es: "El Camarón", en: "The Shrimp", emoji: "🦐" },
  { id: 31, es: "Las Jaras", en: "The Arrows", emoji: "🏹" },
  { id: 32, es: "El Músico", en: "The Musician", emoji: "🎺" },
  { id: 33, es: "La Araña", en: "The Spider", emoji: "🕷️" },
  { id: 34, es: "El Soldado", en: "The Soldier", emoji: "💂" },
  { id: 35, es: "La Estrella", en: "The Star", emoji: "⭐" },
  { id: 36, es: "El Cazo", en: "The Ladle", emoji: "🍲" },
  { id: 37, es: "El Mundo", en: "The World", emoji: "🌎" },
  { id: 38, es: "El Apache", en: "The Apache", emoji: "🪶" },
  { id: 39, es: "El Nopal", en: "The Prickly Pear Cactus", emoji: "🌵" },
  { id: 40, es: "El Alacrán", en: "The Scorpion", emoji: "🦂" },
  { id: 41, es: "La Rosa", en: "The Rose", emoji: "🌹" },
  { id: 42, es: "La Calavera", en: "The Skull", emoji: "☠️" },
  { id: 43, es: "La Campana", en: "The Bell", emoji: "🔔" },
  { id: 44, es: "El Cantarito", en: "The Little Water Pitcher", emoji: "🏺" },
  { id: 45, es: "El Venado", en: "The Deer", emoji: "🦌" },
  { id: 46, es: "El Sol", en: "The Sun", emoji: "☀️" },
  { id: 47, es: "La Corona", en: "The Crown", emoji: "👑" },
  { id: 48, es: "La Chalupa", en: "The Canoe", emoji: "🛶" },
  { id: 49, es: "El Pino", en: "The Pine", emoji: "🌲" },
  { id: 50, es: "El Pescado", en: "The Fish", emoji: "🐟" },
  { id: 51, es: "La Palma", en: "The Palm", emoji: "🌴" },
  { id: 52, es: "La Maceta", en: "The Flowerpot", emoji: "🪴" },
  { id: 53, es: "El Arpa", en: "The Harp", emoji: "🎼" },
  { id: 54, es: "La Rana", en: "The Frog", emoji: "🐸" },
];

export const DECK_SIZE = DECK.length;

export function cardById(id: number): LoteriaCard {
  return DECK[id - 1] ?? { id, es: `Carta ${id}`, en: `Card ${id}`, emoji: "🃏" };
}
