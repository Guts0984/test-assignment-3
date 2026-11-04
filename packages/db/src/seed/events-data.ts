export const cities = [
  { name: "London", venues: ["Royal Albert Hall", "The O2 Arena", "Barbican Centre"] },
  { name: "Berlin", venues: ["Tempodrom", "Berghain Hall", "Columbiahalle"] },
  { name: "Paris", venues: ["Olympia", "Salle Pleyel", "Le Trianon"] },
  { name: "Madrid", venues: ["Teatro Real", "WiZink Center", "La Riviera"] },
  { name: "Rome", venues: ["Auditorium Parco della Musica", "Teatro Argentina", "Palazzo dei Congressi"] },
  { name: "Amsterdam", venues: ["Paradiso", "Ziggo Dome", "Concertgebouw"] },
  { name: "Vienna", venues: ["Wiener Stadthalle", "Konzerthaus", "Volkstheater"] },
  { name: "Prague", venues: ["O2 Arena Prague", "Rudolfinum", "Lucerna Hall"] },
] as const;

export interface EventKind {
  kind: string;
  titles: readonly string[];
  blurbs: readonly string[];
}

export const eventKinds: readonly EventKind[] = [
  {
    kind: "concert",
    titles: [
      "Northern Lights Live",
      "Midnight Orchestra in Concert",
      "Velvet Echo Tour",
      "Crimson Tide Quartet",
      "Blue Harbor Jazz Night",
      "Neon Meridian Live",
    ],
    blurbs: [
      "An evening of live music with a full band and a short acoustic set at the end.",
      "Two hours of songs from the new album, played in the hall the band loves most.",
      "A relaxed concert with guest musicians and an open floor for dancing.",
    ],
  },
  {
    kind: "theatre",
    titles: [
      "The Glass Orchard",
      "A Winter Letter",
      "Tomorrow at the Harbour",
      "The Last Tram",
      "Two Clocks, One Hour",
    ],
    blurbs: [
      "A new staging of a modern classic with an intimate cast of six.",
      "A drama about a family reunion that goes wrong in the funniest possible way.",
      "A critically praised production, with a short interval and a talk after the show.",
    ],
  },
  {
    kind: "conference",
    titles: [
      "Web Platform Summit",
      "Data Engineering Days",
      "Cloud Native Forum",
      "Product Design Conference",
      "Security Practitioners Meetup",
    ],
    blurbs: [
      "A full day of talks from practitioners, with coffee breaks and time to meet speakers.",
      "Practical sessions on real systems: what worked, what broke, and what we changed.",
      "Two tracks, ten talks and a closing panel. Lunch is included.",
    ],
  },
  {
    kind: "festival",
    titles: [
      "Riverside Food Festival",
      "Summer Lanterns Festival",
      "Old Town Street Music Festival",
      "Autumn Harvest Fair",
      "Open Air Film Festival",
    ],
    blurbs: [
      "Stalls, live music and activities for all ages across the whole day.",
      "A weekend festival with local makers, food trucks and evening performances.",
      "Free entry to the grounds; this ticket covers the main stage and the tasting area.",
    ],
  },
  {
    kind: "stand-up",
    titles: [
      "Comedy Cellar Night",
      "Laugh Out Loud: The Tour",
      "Late Night Stand-up Showcase",
      "Improv Against the Clock",
    ],
    blurbs: [
      "Five comedians, one host and a fast, friendly crowd.",
      "A touring stand-up special with brand new material.",
      "An evening of improvised comedy built from suggestions by the audience.",
    ],
  },
  {
    kind: "exhibition",
    titles: [
      "Light and Shadow: Modern Photography",
      "Ceramics of the North",
      "Digital Art Now",
      "Posters of the Century",
    ],
    blurbs: [
      "A guided tour through the collection, with a curator answering questions.",
      "A hands-on exhibition where visitors can touch and try many of the works.",
      "Late opening with music and a small bar in the courtyard.",
    ],
  },
  {
    kind: "sport",
    titles: [
      "City Derby Football Match",
      "Indoor Basketball Cup Final",
      "Marathon Expo and Charity Run",
      "Ice Hockey Night",
    ],
    blurbs: [
      "A league match with family stands and a fan zone open two hours before the start.",
      "The deciding game of the season, in front of a full house.",
      "Pick up your starter pack, meet the organisers and join the charity run.",
    ],
  },
  {
    kind: "workshop",
    titles: [
      "Introduction to Sourdough",
      "Street Photography Walk",
      "Learn to Code: First Steps",
      "Watercolour for Beginners",
    ],
    blurbs: [
      "A small group workshop. All materials are provided; just bring curiosity.",
      "Four hours with an experienced teacher, a break for tea, and notes to take home.",
      "No experience needed. Places are limited so everyone gets help.",
    ],
  },
];

export const capacities = [20, 30, 50, 80, 100, 150, 200, 300, 500] as const;
