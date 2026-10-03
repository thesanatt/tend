// Browser and Node wrapper over the Emscripten build of the Tend law engine.
//
//   import { loadTend } from '/engine/tend_engine.mjs';
//   const tend = await loadTend();
//   const image = new Uint8Array(await (await fetch('/engine/laws/MI.tlaw')).arrayBuffer());
//   const result = tend.evaluate(image, claim);   // same JSON as the native engine
//
// Everything runs locally; nothing about the claim leaves the device.
import createTendModule from './tend.js';

export async function loadTend(moduleOptions = {}) {
  const M = await createTendModule(moduleOptions);

  // Copies the image into WASM memory, runs fn(ptr, len), and always frees.
  function withImage(image, fn) {
    const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
    const ptr = M._malloc(bytes.length || 1);
    if (!ptr) throw new Error('tend: out of memory');
    try {
      M.HEAPU8.set(bytes, ptr);
      return fn(ptr, bytes.length);
    } finally {
      M._free(ptr);
    }
  }

  function takeString(ptr) {
    if (!ptr) throw new Error('tend: out of memory');
    try {
      return M.UTF8ToString(ptr);
    } finally {
      M._tend_free(ptr);
    }
  }

  function evaluateRaw(image, inputJson) {
    return withImage(image, (ptr, len) => {
      const input = M.stringToNewUTF8(inputJson);
      if (!input) throw new Error('tend: out of memory');
      try {
        return takeString(M._tend_eval_json(ptr, len, input));
      } finally {
        M._free(input);
      }
    });
  }

  // Claim bytes in, result bytes out: exactly what the C ABI returns, for
  // checks that compare the WASM and native engines byte for byte.
  function evaluateBytes(image, input) {
    const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(input);
    return withImage(image, (ptr, len) => {
      const inPtr = M._malloc(bytes.length + 1);
      if (!inPtr) throw new Error('tend: out of memory');
      try {
        M.HEAPU8.set(bytes, inPtr);
        M.HEAPU8[inPtr + bytes.length] = 0;
        const out = M._tend_eval_json(ptr, len, inPtr);
        if (!out) throw new Error('tend: out of memory');
        try {
          let end = out;
          while (M.HEAPU8[end] !== 0) end++;
          return M.HEAPU8.slice(out, end);
        } finally {
          M._tend_free(out);
        }
      } finally {
        M._free(inPtr);
      }
    });
  }

  return {
    version: () => M.UTF8ToString(M._tend_version()),
    evaluateBytes,
    // Returns the engine output, or {error: {code, message}}.
    evaluate: (image, claim) => JSON.parse(evaluateRaw(image, typeof claim === 'string' ? claim : JSON.stringify(claim))),
    evaluateRaw,
    disassemble: (image) => withImage(image, (ptr, len) => takeString(M._tend_disasm(ptr, len))),
    inspect: (image) => JSON.parse(withImage(image, (ptr, len) => takeString(M._tend_inspect_json(ptr, len)))),
  };
}
