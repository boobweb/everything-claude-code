export interface Question { q: string; a: string[]; c: number }
export type Mode = 'hero' | 'blitz';
export enum Theme { Neuro, Msk }
export function score(q: Question, pick: number): number { return q.c === pick ? 1 : 0; }
export class Bank { constructor(public items: Question[]) {} size(): number { return this.items.length; } }
