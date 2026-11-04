// Minimal WASM export-section reader: tells which methods deployed code actually exposes.
const EXPORT_SECTION = 7;
const FUNC_KIND = 0;

function leb128(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = bytes[pos];
    if (byte === undefined) throw new Error("truncated LEB128");
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 35) throw new Error("LEB128 too long");
  }
}

/** Names of exported functions. Throws on anything that is not a WASM module. */
export function wasmFunctionExports(bytes: Uint8Array): string[] {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("not a WASM module");
  let pos = 8;
  const names: string[] = [];
  while (pos < bytes.length) {
    const id = bytes[pos];
    const [size, start] = leb128(bytes, pos + 1);
    const end = start + size;
    if (id === EXPORT_SECTION) {
      let [count, p] = leb128(bytes, start);
      while (count-- > 0) {
        const [len, s] = leb128(bytes, p);
        const name = Buffer.from(bytes.subarray(s, s + len)).toString("utf8");
        const kind = bytes[s + len];
        const [, next] = leb128(bytes, s + len + 1);
        if (kind === FUNC_KIND) names.push(name);
        p = next;
      }
    }
    pos = end;
  }
  return names;
}
