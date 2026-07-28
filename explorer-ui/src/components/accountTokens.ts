// Split free text into address-ish tokens (no client-side validation — the
// server owns that; this only decides token boundaries). People paste lists
// exactly as copied — newline-, comma-, semicolon-, or space-separated — and
// the picker shouldn't care which.
export function tokenizeAddresses(input: string): string[] {
  return input.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean)
}
