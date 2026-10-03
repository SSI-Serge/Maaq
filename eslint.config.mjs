import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [".next/**", "node_modules/**", "docs/**", ".data/**", "dashboard.html", "src/server/db/schema.generated.ts"],
  },
];

export default config;
