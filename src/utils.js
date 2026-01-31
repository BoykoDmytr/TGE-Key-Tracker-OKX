export function toTopicAddress(address) {
  const a = address.toLowerCase().replace(/^0x/, "");
  return "0x" + a.padStart(64, "0");
}