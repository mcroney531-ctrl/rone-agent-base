// http_ece ships no types; the push test only uses decrypt().
declare module 'http_ece' {
  const ece: { decrypt(buffer: Buffer, params: Record<string, unknown>): Buffer };
  export default ece;
}
