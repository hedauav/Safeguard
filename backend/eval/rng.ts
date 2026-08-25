/**
 * A small seeded PRNG.
 *
 * The dev set and the holdout are generated from different seeds. That is the
 * entire point of this file: a holdout drawn from the same seed is the
 * development set wearing a different filename, and a score against it means
 * nothing. `mulberry32` is used because it is short enough to read, has no
 * dependencies, and is stable across Node versions — a generator whose output
 * drifts with the runtime cannot be sealed.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed) || seed <= 0) {
      throw new Error(`Rng: seed must be a positive integer, got ${seed}`);
    }
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** A rupee amount in [min, max], rounded to the nearest hundred. */
  rupees(min: number, max: number): number {
    return Math.round(this.int(min, max) / 100) * 100;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[this.int(0, items.length - 1)]!;
  }

  /** `n` distinct items, in the order they were drawn. */
  sample<T>(items: readonly T[], n: number): T[] {
    if (n > items.length) throw new Error(`Rng.sample: asked for ${n} of ${items.length}`);
    const pool = [...items];
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(...pool.splice(this.int(0, pool.length - 1), 1));
    return out;
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /** Fisher-Yates, in place, returning the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}

/** ISO date arithmetic in whole days, with no timezone to get wrong. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Indian-format grouping: 1234567 -> "12,34,567". */
export function inr(amount: number): string {
  const s = Math.round(Math.abs(amount)).toString();
  const sign = amount < 0 ? '-' : '';
  if (s.length <= 3) return sign + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}${rest},${last3}`;
}
