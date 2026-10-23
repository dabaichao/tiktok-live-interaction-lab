/** Count Unicode characters, not UTF-16 code units (rare Han characters count once). */
export function guessCharacterCount(normalizedText: string): number {
  return Array.from(normalizedText).length;
}

export function roundGuessRejection(normalizedText: string, expectedLength: number, language: string): "length_mismatch" | "not_word" | undefined {
  if (guessCharacterCount(normalizedText) !== expectedLength) return "length_mismatch";
  // Do not remove punctuation/digits/spaces and accidentally turn chat into a guess.
  if (language === "zh-Hans" && !/^\p{Script=Han}+$/u.test(normalizedText)) return "not_word";
  return undefined;
}
