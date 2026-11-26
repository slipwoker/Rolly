/** Types of the Hebrew addressing preference (memory/addressing.ts keeps the state machine; core.ts words the prompt line). */

export type AddressingValue = "masculine" | "feminine" | "plural";
export type AddressingStatus = "unknown" | "inferred" | "confirmed";

export interface AddressingState {
  value: AddressingValue | null;
  status: AddressingStatus;
  evidenceCount?: number;
}
