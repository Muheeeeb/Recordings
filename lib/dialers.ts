/**
 * Groups the S3 folders into the dialer that produced them.
 *
 * The bucket has one folder per campaign, but those campaigns come from three
 * different dialer systems, and that is the distinction people actually think
 * in. Folders are matched on a normalised key, so a folder named "KTN Group",
 * "KTN_Group" or "ktn-group" all resolve the same way — the dialer vendors have
 * changed naming on us before.
 */

export const DIALERS = ['CCS', 'KTN', 'Rockey', 'Morpheus'] as const
export type Dialer = (typeof DIALERS)[number] | 'Other'

/** Anything not listed falls here rather than disappearing from the UI. */
export const UNKNOWN_DIALER: Dialer = 'Other'

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

const MAP = new Map<string, Dialer>(
  (
    [
      ['Closers_ACA', 'CCS'],
      ['Closers_Medicare', 'CCS'],
      // Main_ACA_Fronter was retired after its contents expired; ACA_Fronter
      // replaces it. The old name stays mapped so historical rows keep their
      // dialer if any are ever restored from versions.
      ['Main_ACA_Fronter', 'CCS'],
      ['ACA_Fronter', 'CCS'],
      ['Main_Medicare_Fronter', 'CCS'],
      ['KTN_Group', 'KTN'],
      ['Rockey_Dialer', 'Rockey'],
      // Only closers and the self verifier are imported. Fronter, the bots
      // campaign and recordings whose campaign comes back blank are skipped
      // deliberately — Fronter alone is 69,000 calls a day.
      ['Morpheus_Fronter', 'Morpheus'],
      ['Morpheus_Closer', 'Morpheus'],
      ['Morpheus_Closer2', 'Morpheus'],
      // Morpheus renamed its campaigns on 20 Nov 2026: Closer became
      // ACA-CLOSER and Closer2 became Med-Closer, which puts the product in
      // the campaign instead of only in the agent's label. The folders we pull
      // into follow the new names; the two above stay mapped so anything
      // already filed under them keeps its dialer.
      ['Morpheus_ACA_Closer', 'Morpheus'],
      ['Morpheus_Med_Closer', 'Morpheus'],
      ['Morpheus_Self_Verifier', 'Morpheus'],
      // A closer campaign under a name we have not seen yet is still Morpheus.
      ['Morpheus_Closer_Other', 'Morpheus'],
    ] as [string, Dialer][]
  ).map(([group, dialer]) => [normalise(group), dialer])
)

export function dialerForGroup(group: string): Dialer {
  return MAP.get(normalise(group)) ?? UNKNOWN_DIALER
}

/** Display name for a folder: "Main_ACA_Fronter" reads better with spaces. */
export const groupLabel = (group: string) => group.replace(/_/g, ' ')

/**
 * Every dialer that has data, in a stable order, with "Other" last so a newly
 * appeared folder is visible without pushing the known dialers around.
 */
export function orderDialers(present: Iterable<string>): string[] {
  const set = new Set(present)
  const known = DIALERS.filter((d) => set.has(d))
  return set.has(UNKNOWN_DIALER) ? [...known, UNKNOWN_DIALER] : known
}
