import type { NewEvent } from "../schema";
import { capacities, cities, eventKinds } from "./events-data";
import { createRandom } from "./random";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

export const EVENT_COUNT = 200;
export const SEED_WINDOW_DAYS = 90;

export function generateEvents(now: Date, seed = 20_260_101): NewEvent[] {
  const random = createRandom(seed);
  const earliest = now.getTime() + 60 * 60 * 1000;
  const span = SEED_WINDOW_DAYS * DAY_MS - 60 * 60 * 1000;

  return Array.from({ length: EVENT_COUNT }, (_, index): NewEvent => {
    const city = cities[index % cities.length];
    const kind = random.pick(eventKinds);
    const offset =
      Math.floor((random.next() * span) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;

    if (!city) throw new Error("cities list is empty");
    return {
      title: random.pick(kind.titles),
      description: random.pick(kind.blurbs),
      city: city.name,
      venue: random.pick(city.venues),
      startsAt: new Date(earliest + offset),
      capacity: random.pick(capacities),
    };
  });
}
