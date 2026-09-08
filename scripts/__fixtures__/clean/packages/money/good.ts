// FIXTURE: must produce zero violations.
export interface Good {
  amountMinor: string;
  scale: 2 | 8 | 18;
}
export const add = (a: string, b: string): string => `${a}+${b}`;
