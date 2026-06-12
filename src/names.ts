// Friendly, claimable share names.
//
// A share id has the shape `<prefix>-<suffix>`:
//   - prefix: a rememberable, human-friendly word. By default it is a made-up
//     (but pronounceable) word so the URL is easy to recall and share. The owner
//     can later *claim* a custom prefix of their own — see normalizeClaimPrefix.
//   - suffix: NAME_SUFFIX_LENGTH random chars from an unambiguous alphabet. It
//     keeps ids conflict-free even when two shares claim the same prefix, so the
//     friendly part never has to be globally unique.
//
// Example generated id: `mirovel-3f7k`. Example claimed id: `my-demo-3f7k`.

import { AppError } from "./types";

// Pronounceable building blocks. A syllable is onset + vowel; a word is two or
// three syllables with an optional trailing coda. This yields clearly made-up
// yet readable words (mirovel, zaethun, brusta, cleestor, ...).
const ONSETS = [
  "b", "br", "c", "ch", "cl", "cr", "d", "dr", "f", "fl", "fr", "g", "gl", "gr",
  "h", "j", "k", "l", "m", "n", "p", "pl", "pr", "qu", "r", "s", "sh", "sk",
  "sl", "sn", "sp", "st", "t", "th", "tr", "tw", "v", "w", "z",
];
// Inner syllables use single vowels; only the final syllable may take a richer
// digraph, which keeps words short and avoids awkward vowel pileups.
const VOWELS = ["a", "e", "i", "o", "u"];
const FINAL_VOWELS = [...VOWELS, "ai", "au", "ei", "ou", "oo", "ee"];
const CODAS = ["n", "r", "l", "s", "x", "k", "m", "th", "nd", "st", "ll", "sh", "ng"];

// Excludes visually ambiguous chars (0/o, 1/l/i) so a suffix is easy to read
// aloud and retype.
const SUFFIX_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export const NAME_SUFFIX_LENGTH = 4;

// Validates an id coming off the URL before any lookup: lowercase alphanumerics
// and internal hyphens, 3-64 chars, no leading/trailing hyphen. Permissive
// enough to accept every generated and claimed id while rejecting uppercase,
// underscores, dots, slashes and other oddities.
export const SHARE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

// A claimable prefix: 1-32 chars, lowercase alphanumeric + internal single
// hyphens, no leading/trailing hyphen.
const PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_PREFIX_LENGTH = 32;

function randInt(maxExclusive: number): number {
  // Rejection sampling keeps the distribution uniform across the byte range.
  const limit = 256 - (256 % maxExclusive);
  const buf = new Uint8Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  } while (value >= limit);
  return value % maxExclusive;
}

function pick<T>(items: readonly T[]): T {
  return items[randInt(items.length)]!;
}

/** A made-up, pronounceable word used as the default (claimable) prefix. */
export function generateFriendlyPrefix(): string {
  // Mostly 2 syllables (short, snappy); occasionally 3 for variety.
  const syllableCount = randInt(3) === 0 ? 3 : 2;
  let word = "";
  for (let i = 0; i < syllableCount; i += 1) {
    const isFinal = i === syllableCount - 1;
    word += pick(ONSETS) + pick(isFinal ? FINAL_VOWELS : VOWELS);
  }
  // ~50% of words get a trailing consonant so they read like a real name.
  if (randInt(2) === 0) {
    word += pick(CODAS);
  }
  return word;
}

/** A random conflict-free suffix from the unambiguous alphabet. */
export function generateSuffix(): string {
  let suffix = "";
  for (let i = 0; i < NAME_SUFFIX_LENGTH; i += 1) {
    suffix += SUFFIX_ALPHABET[randInt(SUFFIX_ALPHABET.length)];
  }
  return suffix;
}

export function buildShareId(prefix: string, suffix: string): string {
  return `${prefix}-${suffix}`;
}

/** A fresh `<friendly>-<suffix>` id. Uniqueness is enforced by the caller. */
export function generateArtifactId(): string {
  return buildShareId(generateFriendlyPrefix(), generateSuffix());
}

/** Splits an id into prefix + suffix, or null if it isn't a well-formed share id. */
export function splitShareId(id: string): { prefix: string; suffix: string } | null {
  const dash = id.lastIndexOf("-");
  if (dash <= 0 || dash === id.length - 1) {
    return null;
  }
  return { prefix: id.slice(0, dash), suffix: id.slice(dash + 1) };
}

/**
 * Validates and normalizes a user-supplied prefix for a claim. Trims, lowercases,
 * and collapses runs of separators to single hyphens so "My Cool Demo" becomes
 * "my-cool-demo". Throws AppError(400) when nothing usable remains.
 */
export function normalizeClaimPrefix(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppError(400, "invalid_name", "Name must be a string");
  }
  const prefix = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → single hyphen
    .replace(/^-+|-+$/g, ""); // drop leading/trailing hyphens

  if (!prefix) {
    throw new AppError(400, "invalid_name", "Name must contain at least one letter or number");
  }
  if (prefix.length > MAX_PREFIX_LENGTH) {
    throw new AppError(400, "invalid_name", `Name must be at most ${MAX_PREFIX_LENGTH} characters`);
  }
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new AppError(400, "invalid_name", "Name must be lowercase letters, numbers, and hyphens");
  }
  return prefix;
}
