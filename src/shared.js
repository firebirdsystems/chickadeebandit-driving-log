// Mirrors the subset of /hub-sdk.js that pure logic depends on, so logic.js can be
// unit-tested without the browser-only SDK. Keep in sync with hub-sdk.
export function isAdult(member) {
  return !!member && member.role === "adult";
}
