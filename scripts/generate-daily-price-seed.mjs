import { mkdir, writeFile } from "node:fs/promises";

const outputPath = new URL("../data/daily-price-seed.json", import.meta.url);
const updated = process.env.PRICE_DATE || tokyoDate(new Date());
const seed = hashString(updated);
const regular = 166 + (seed % 10);
const premium = regular + 13 + (seed % 3);
const diesel = regular - 17 + (seed % 4);

const payload = {
  updated,
  currency: "JPY",
  unit: "L",
  source: "daily-estimate",
  note: "自動生成の推定価格です。実価格データソース接続後はこの生成処理を置き換えてください。",
  salt: `${updated}-${seed}`,
  baselines: {
    regular,
    premium,
    diesel,
  },
};

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Updated ${outputPath.pathname} for ${updated}`);

function tokyoDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
