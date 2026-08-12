import { describe, expect, it } from "vitest";
import { observed, unavailable } from "../report-contract";

describe("report-contract helpers", () => {
  it("observed() wraps a value with status OBSERVED", () => {
    expect(observed(291)).toEqual({ status: "OBSERVED", value: 291 });
  });

  it("unavailable() carries a human-readable reason, never a fabricated value", () => {
    const field = unavailable("No validated revenue model implemented yet");
    expect(field).toEqual({ status: "UNAVAILABLE", reason: "No validated revenue model implemented yet" });
    expect("value" in field).toBe(false); // structurally impossible to smuggle a number in alongside UNAVAILABLE
  });
});
