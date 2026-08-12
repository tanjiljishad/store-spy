import nextConfig from "eslint-config-next";

/** @type {import('eslint').Linter.Config[]} */
const config = [
  { ignores: [".next/**", "node_modules/**", "prisma/migrations/**", "coverage/**"] },
  ...nextConfig,
];

export default config;
