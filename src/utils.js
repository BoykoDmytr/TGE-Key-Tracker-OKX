//export function includesKey(s) {
  if (!s) return false;
  return String(s).toLowerCase().includes("key");
//}

/**
 * Convert address to topic-form (32-byte left-padded)
 * Example: 0xabc... -> 0x0000...abc...
 */
export function toTopicAddress(address) {
  const a = address.toLowerCase().replace(/^0x/, "");
  return "0x" + a.padStart(64, "0");
}
