/**
 * Building HTML from text that cannot be trusted. Every value interpolated into
 * the `html` tag is escaped, so markup can only come from the code that calls it.
 */
import { readFileSync } from "node:fs";

/** Markup that is safe to insert as it is. Anything else interpolated into `html` is escaped. */
export class Markup {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Markup {
  return new Markup(strings.reduce((out, part, i) => out + insert(values[i - 1]) + part));
}

function insert(value: unknown): string {
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map(insert).join("");
  if (value === null || value === undefined || value === false) return "";
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A stylesheet or script of the lab's own, to be inlined. */
export function asset(file: URL): Markup {
  return new Markup(readFileSync(file, "utf8"));
}
