import { bytesToBase64Url, randomBytes } from "@atlastodo/client-core";
import { prfOutputOf } from "./passkeyJson";

describe("prfOutputOf", () => {
  it("reads the PRF output Credential Manager returns", () => {
    const out = randomBytes(32);
    expect(
      prfOutputOf({
        clientExtensionResults: { prf: { results: { first: bytesToBase64Url(out) } } },
      }),
    ).toEqual(out);
  });

  it("is null without one, or for anything that is not 32 bytes of base64url", () => {
    expect(prfOutputOf({ clientExtensionResults: {} })).toBeNull();
    expect(prfOutputOf({ clientExtensionResults: { prf: { enabled: true } } })).toBeNull();
    expect(
      prfOutputOf({ clientExtensionResults: { prf: { results: { first: "AAAA" } } } }),
    ).toBeNull();
    expect(
      prfOutputOf({ clientExtensionResults: { prf: { results: { first: "not+base64" } } } }),
    ).toBeNull();
  });
});
