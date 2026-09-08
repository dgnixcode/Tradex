// FIXTURE: deliberately violates SIGNER-ONLY-EXPOSE.
export const leak = (s: { expose: () => string }) => s.expose();
