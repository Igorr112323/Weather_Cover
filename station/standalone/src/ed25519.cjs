/* ── Ed25519 и SHA-512 на чистом JS ─────────────────────────────────────────
 * Нужны для браузеров, где WebCrypto не умеет Ed25519: алгоритм появился в
 * Chrome и Edge только в 137 (май 2025), в Firefox — в 130, в Safari — в 17.
 * На Яндекс.Браузере и других старых Chromium подпись иначе невозможна, а
 * выдавать код приходится и там.
 *
 * Результат побайтово совпадает с WebCrypto и с Node (Ed25519 детерминирован:
 * подпись зависит только от ключа и сообщения), поэтому код, выписанный этим
 * путём, принимает приложение. Совпадение проверяет тест
 * station/tests/ed25519.test.mjs — он же сверяет SHA-512 с crypto.createHash.
 *
 * Постоянства по времени здесь нет: подпись ставит владелец своими ключами в
 * своём браузере, злоумышленника рядом нет. Для проверки чужих подписей в
 * приложении по-прежнему используется Node/WebCrypto.
 *
 * Файл двусторонний: его инлайнит сборщик страниц ( scripts/build-standalone.mjs )
 * в обвязку, и его же импортируют тесты.
 */
const AGRO_ED25519 = (() => {
  const P = (1n << 255n) - 19n;
  /** Порядок базовой точки: L = 2^252 + 27742317777372353535851937790883648493. */
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  const MASK64 = (1n << 64n) - 1n;

  function mod(value, m = P) {
    const rest = value % m;
    return rest < 0n ? rest + m : rest;
  }

  function pow(base, exponent, m) {
    let result = 1n;
    let power = mod(base, m);
    let e = exponent;
    while (e > 0n) {
      if (e & 1n) result = result * power % m;
      power = power * power % m;
      e >>= 1n;
    }
    return result;
  }

  const inv = (value) => pow(value, P - 2n, P);

  /* ── целочисленные корни (нужны только для таблиц SHA-512) ──────────────── */

  function isqrt(n) {
    if (n < 2n) return n;
    let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) {
      const next = (x + n / x) >> 1n;
      if (next >= x) break;
      x = next;
    }
    while ((x + 1n) * (x + 1n) <= n) x += 1n;
    while (x * x > n) x -= 1n;
    return x;
  }

  function icbrt(n) {
    if (n < 2n) return n;
    let x = 1n << BigInt(Math.ceil(n.toString(2).length / 3));
    for (;;) {
      const next = (2n * x + n / (x * x)) / 3n;
      if (next >= x) break;
      x = next;
    }
    while ((x + 1n) ** 3n <= n) x += 1n;
    while (x ** 3n > n) x -= 1n;
    return x;
  }

  /* ── SHA-512 (FIPS 180-4) ──────────────────────────────────────────────────
   * Таблицы не переписаны руками: K — первые 64 бита дробной части кубического
   * корня из простых, H — из квадратных корней первых восьми простых. Считаются
   * один раз при первом хешировании, опечатка в 88 числах поэтому невозможна.
   */
  let tables = null;

  function sha512Tables() {
    if (tables) return tables;
    const primes = [];
    for (let candidate = 2; primes.length < 80; candidate += 1) {
      let simple = true;
      for (const prime of primes) {
        if (prime * prime > candidate) break;
        if (candidate % prime === 0) { simple = false; break; }
      }
      if (simple) primes.push(candidate);
    }
    const k = [];
    for (const prime of primes) k.push(icbrt(BigInt(prime) * (1n << 192n)) & MASK64);
    const h = [];
    for (const prime of primes.slice(0, 8)) h.push(isqrt(BigInt(prime) * (1n << 128n)) & MASK64);
    tables = { k, h };
    return tables;
  }

  const rotr = (value, bits) => {
    const n = BigInt(bits);
    return ((value >> n) | (value << (64n - n))) & MASK64;
  };

  /** 64 байта хеша; тот же результат, что у crypto.createHash("sha512"). */
  function sha512(message) {
    const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
    const { k } = sha512Tables();
    const h = sha512Tables().h.slice();
    const total = ((bytes.length + 16) >> 7 << 7) + 128;
    const block = new Uint8Array(total);
    block.set(bytes);
    block[bytes.length] = 0x80;
    const bits = BigInt(bytes.length) * 8n;
    for (let index = 0; index < 8; index += 1) block[total - 1 - index] = Number((bits >> BigInt(index * 8)) & 0xffn);
    const view = new DataView(block.buffer);
    const w = new Array(80);

    for (let offset = 0; offset < total; offset += 128) {
      for (let index = 0; index < 16; index += 1) {
        w[index] = (BigInt(view.getUint32(offset + index * 8)) << 32n) | BigInt(view.getUint32(offset + index * 8 + 4));
      }
      for (let index = 16; index < 80; index += 1) {
        const s0 = rotr(w[index - 15], 1) ^ rotr(w[index - 15], 8) ^ (w[index - 15] >> 7n);
        const s1 = rotr(w[index - 2], 19) ^ rotr(w[index - 2], 61) ^ (w[index - 2] >> 6n);
        w[index] = (w[index - 16] + s0 + w[index - 7] + s1) & MASK64;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let index = 0; index < 80; index += 1) {
        const big1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
        const choice = (e & f) ^ ((MASK64 ^ e) & g);
        const one = (hh + big1 + choice + k[index] + w[index]) & MASK64;
        const big0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const two = (majority + big0) & MASK64;
        hh = g; g = f; f = e; e = (d + one) & MASK64;
        d = c; c = b; b = a; a = (one + two) & MASK64;
      }
      const sum = [a, b, c, d, e, f, g, hh];
      for (let index = 0; index < 8; index += 1) h[index] = (h[index] + sum[index]) & MASK64;
    }

    const out = new Uint8Array(64);
    for (let index = 0; index < 8; index += 1) {
      for (let byte = 0; byte < 8; byte += 1) {
        out[index * 8 + byte] = Number((h[index] >> BigInt(56 - byte * 8)) & 0xffn);
      }
    }
    return out;
  }

  /* ── little-endian ───────────────────────────────────────────────────────── */

  function leToBigInt(bytes) {
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
    return value;
  }

  function bigIntToLe(value, size) {
    const out = new Uint8Array(size);
    let rest = value;
    for (let index = 0; index < size; index += 1) {
      out[index] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return out;
  }

  function concat(...parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /* ── кривая (расширенные координаты Эдвардса: x = X/Z, y = Y/Z, T = xy/Z) ─ */

  const D = mod(-121665n * inv(121666n));
  const SQRT_M1 = pow(2n, (P - 1n) / 4n, P);
  const ZERO = [0n, 1n, 1n, 0n];

  function addPoint(p1, p2) {
    const [x1, y1, z1, t1] = p1;
    const [x2, y2, z2, t2] = p2;
    const a = mod((y1 - x1) * (y2 - x2));
    const b = mod((y1 + x1) * (y2 + x2));
    const c = mod(t1 * 2n * D * t2);
    const dd = mod(z1 * 2n * z2);
    const e = mod(b - a);
    const f = mod(dd - c);
    const g = mod(dd + c);
    const hh = mod(b + a);
    return [mod(e * f), mod(g * hh), mod(f * g), mod(e * hh)];
  }

  function doublePoint(point) {
    const [x, y, z, t] = point;
    const a = mod(x * x);
    const b = mod(y * y);
    const c = mod(2n * mod(z * z));
    const dd = mod(-a);
    const e = mod((x + y) ** 2n - a - b);
    const g = mod(dd + b);
    const f = mod(g - c);
    const hh = mod(dd - b);
    return [mod(e * f), mod(g * hh), mod(f * g), mod(e * hh)];
  }

  function multiply(scalar, point) {
    let result = ZERO;
    let addend = point;
    let k = scalar;
    while (k > 0n) {
      if (k & 1n) result = addPoint(result, addend);
      addend = doublePoint(addend);
      k >>= 1n;
    }
    return result;
  }

  /** Распаковка точки из 32 байт (RFC 8032, §5.6.1). null — точка вне кривой. */
  function decompress(bytes) {
    if (bytes.length !== 32) return null;
    const copy = Uint8Array.from(bytes);
    const sign = (copy[31] >> 7) & 1;
    copy[31] &= 0x7f;
    const y = leToBigInt(copy);
    if (y >= P) return null;
    const y2 = mod(y * y);
    const u = mod(y2 - 1n);
    const v = mod(D * y2 + 1n);
    // x² = (y² − 1) / (d·y² + 1); для p ≡ 5 (mod 8) корень — степень (p+3)/8,
    // а если попался корень из −x², домножаем на √−1.
    const square = mod(u * inv(v));
    let x = pow(square, (P + 3n) / 8n, P);
    if (mod(x * x) !== square) {
      x = mod(x * SQRT_M1);
      if (mod(x * x) !== square) return null;
    }
    if (x === 0n && sign === 1) return null;
    if (Number(x & 1n) !== sign) x = P - x;
    return [mod(x * v), mod(y * v), v, mod(x * y % P * v)];
  }

  /** Упаковка точки в 32 байта: y + старший бит = чётность x. */
  function compress(point) {
    const [x, y, z] = point;
    const zi = inv(z);
    const affineX = mod(x * zi);
    const affineY = mod(y * zi);
    const out = bigIntToLe(affineY, 32);
    if (affineX & 1n) out[31] |= 0x80;
    return out;
  }

  /*
   * Базовая точка: y = 4/5, sign = 0. Восстанавливается лениво — в браузере без
   * BigInt (а он и есть причина всего этого файла) вычисление не должно падать
   * прямо при загрузке страницы: сначала страница успевает объяснить, что делать.
   */
  let basePoint = null;

  function base() {
    if (!basePoint) {
      const y = mod(4n * inv(5n));
      const point = decompress(bigIntToLe(y, 32));
      if (!point) throw new Error("Не удалось восстановить базовую точку Ed25519.");
      basePoint = point;
    }
    return basePoint;
  }

  /* ── ключи, подпись, проверка (RFC 8032 §5.1.6) ─────────────────────────── */

  function expandSeed(seed) {
    const hash = sha512(seed);
    const head = hash.slice(0, 32);
    head[0] &= 0xf8;
    head[31] = (head[31] & 0x7f) | 0x40;
    return { scalar: leToBigInt(head), prefix: hash.slice(32) };
  }

  /** Открытый ключ (32 байта) по 32-байтному seed'у. */
  function publicKeyFromSeed(seed) {
    return compress(multiply(expandSeed(seed).scalar, base()));
  }

  /** 64-байтная подпись; seed — 32 байта из PKCS#8. */
  function sign(seed, message) {
    const { scalar, prefix } = expandSeed(seed);
    const g = base();
    const publicKey = compress(multiply(scalar, g));
    const r = mod(leToBigInt(sha512(concat(prefix, message))), L);
    const bigR = compress(multiply(r, g));
    const k = mod(leToBigInt(sha512(concat(bigR, publicKey, message))), L);
    return concat(bigR, bigIntToLe(mod(r + k * scalar, L), 32));
  }

  function verify(publicKey, signature, message) {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    const s = leToBigInt(signature.slice(32));
    if (s >= L) return false;
    const pointA = decompress(publicKey);
    const pointR = decompress(signature.slice(0, 32));
    if (!pointA || !pointR) return false;
    const k = mod(leToBigInt(sha512(concat(signature.slice(0, 32), publicKey, message))), L);
    const left = multiply(s, base());
    const right = addPoint(pointR, multiply(k, pointA));
    const a = compress(left);
    const b = compress(right);
    let diff = 0;
    for (let index = 0; index < 32; index += 1) diff |= a[index] ^ b[index];
    return diff === 0;
  }

  return { sha512, sign, verify, publicKeyFromSeed, compress, decompress, multiply, BASE: base, ORDER: L };
})();

if (typeof module !== "undefined" && module.exports) module.exports = AGRO_ED25519;
