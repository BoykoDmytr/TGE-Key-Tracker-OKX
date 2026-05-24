import { decodeSetTime, SETTIME_SELECTOR } from "../src/evm/decodeSetTime";

describe("decodeSetTime", () => {
  it("decodes startTime and duration from the reference vector", () => {
    // startTime = 0x6a5b5cb0 = 1784372400, duration = 0x127500 = 1209600 (14 days)
    const input =
      SETTIME_SELECTOR +
      "000000000000000000000000000000000000000000000000000000006a5b5cb0" +
      "0000000000000000000000000000000000000000000000000000000000127500";

    const decoded = decodeSetTime(input);
    expect(decoded).not.toBeNull();
    expect(decoded!.startTime).toBe(1784372400);
    expect(decoded!.duration).toBe(1209600);
  });

  it("returns null for a non-setTime selector", () => {
    expect(decodeSetTime("0xdeadbeef" + "00".repeat(64))).toBeNull();
  });

  it("returns null for truncated calldata", () => {
    expect(decodeSetTime(SETTIME_SELECTOR + "00")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(decodeSetTime("")).toBeNull();
  });
});
