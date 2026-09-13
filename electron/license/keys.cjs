/**
 * Открытые ключи лицензий и список отозванных лицензий.
 *
 * Файл создаётся командой  npm run license:keygen  (scripts/license-tool.mjs)
 * и является единственной доверенной точкой проверки подписи в приложении.
 * Закрытого ключа здесь нет и быть не должно: он хранится у владельца
 * приложения в secrets/license-key.json (каталог в .gitignore).
 *
 * revokedSerials — серийные номера (hex, 16 символов) лицензий, которые
 * владелец отозвал: такой код перестанет активироваться в следующей сборке.
 */

"use strict";

module.exports = {
  keys: [
    { keyId: 1, label: "production", publicKey:
      "MCowBQYDK2VwAyEASJTsYlvpy8h8Lf4kYgVDHPTqrUyEFLX8j+GQGHiL6Sw=" },
  ],
  revokedSerials: [

  ],
};
