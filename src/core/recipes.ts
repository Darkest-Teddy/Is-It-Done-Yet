/**
 * The tickets. Ten fixed recipes, held locally.
 *
 * Local is the source of truth rather than a cache of one. Master spec rule #12 says to pick
 * whatever survives a live demo on bad wifi, and a recipe list is a few hundred bytes that
 * never changes during a session -- there is no version of "fetch it" that is better than
 * "have it", only versions that are worse when the network is saturated. A remote list can sit
 * in FRONT of this behind a timeout; it must never sit in place of it.
 *
 * Each ticket sets its own tolerance rather than sharing a global one, because the tolerance is
 * part of what makes a ticket easy or hard. Asking for 4mm rounds is a different skill from
 * asking for 12mm batons, and scoring both against the same window would either flatter one or
 * punish the other.
 */

export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly ingredient: string;
  readonly targetThicknessMm: number;
  readonly toleranceMm: number;
  readonly targetSigmaMm: number;
  readonly sliceCount: number;
  /** Shown on the ticket. Plain language, no numbers a player has to convert. */
  readonly note: string;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: 'tzatziki', name: 'Tzatziki', ingredient: 'cucumber',
    targetThicknessMm: 4, toleranceMm: 1.5, targetSigmaMm: 1.5, sliceCount: 8,
    note: 'Thin rounds. They have to disappear into the yoghurt.',
  },
  {
    id: 'sandwich', name: 'Sandwich rounds', ingredient: 'cucumber',
    targetThicknessMm: 6, toleranceMm: 2, targetSigmaMm: 2, sliceCount: 6,
    note: 'Even rounds. Every bite the same.',
  },
  {
    id: 'greek', name: 'Greek salad', ingredient: 'cucumber',
    targetThicknessMm: 10, toleranceMm: 2.5, targetSigmaMm: 2.5, sliceCount: 6,
    note: 'Chunky half-moons. They should hold their shape.',
  },
  {
    id: 'crudites', name: 'Crudites', ingredient: 'cucumber',
    targetThicknessMm: 12, toleranceMm: 3, targetSigmaMm: 3, sliceCount: 5,
    note: 'Batons for dipping. Sturdy enough to hold hummus.',
  },
  {
    id: 'pickles', name: 'Quick pickles', ingredient: 'cucumber',
    targetThicknessMm: 5, toleranceMm: 1.5, targetSigmaMm: 1.5, sliceCount: 10,
    note: 'Ten rounds, all matching. The brine is unforgiving.',
  },
  {
    id: 'sunomono', name: 'Sunomono', ingredient: 'cucumber',
    targetThicknessMm: 2.5, toleranceMm: 1, targetSigmaMm: 1, sliceCount: 8,
    note: 'Paper thin. This is the hard one.',
  },
  {
    id: 'raita', name: 'Raita', ingredient: 'cucumber',
    targetThicknessMm: 8, toleranceMm: 2, targetSigmaMm: 2, sliceCount: 6,
    note: 'Thick rounds, to be diced after.',
  },
  {
    id: 'gazpacho', name: 'Gazpacho prep', ingredient: 'cucumber',
    targetThicknessMm: 15, toleranceMm: 4, targetSigmaMm: 4, sliceCount: 4,
    note: 'Rough chunks. It all goes in the blender anyway.',
  },
  {
    id: 'banh-mi', name: 'Banh mi', ingredient: 'cucumber',
    targetThicknessMm: 3, toleranceMm: 1, targetSigmaMm: 1, sliceCount: 8,
    note: 'Long thin strips. Precision work.',
  },
  {
    id: 'service', name: 'Full service', ingredient: 'cucumber',
    targetThicknessMm: 6, toleranceMm: 1, targetSigmaMm: 1, sliceCount: 12,
    note: 'Twelve rounds at six millimetres. No excuses.',
  },
];

export function recipeById(id: string): Recipe | null {
  return RECIPES.find((r) => r.id === id) ?? null;
}

/** Progress through a ticket, for the panel and for knowing when it is finished. */
export interface TicketProgress {
  readonly done: number;
  readonly required: number;
  readonly complete: boolean;
  /** 0..1, for a bar. Clamped, because a player can always cut one more than they were asked. */
  readonly fraction: number;
}

export function progressOf(recipe: Recipe, cutCount: number): TicketProgress {
  const done = Math.max(0, cutCount);
  return {
    done,
    required: recipe.sliceCount,
    complete: done >= recipe.sliceCount,
    fraction: Math.min(1, recipe.sliceCount === 0 ? 1 : done / recipe.sliceCount),
  };
}
