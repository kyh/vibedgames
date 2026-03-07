import baseConfig from "@kyh/eslint-config/base";
import nextjsConfig from "@kyh/eslint-config/nextjs";
import reactConfig from "@kyh/eslint-config/react";

/** @type {import('typescript-eslint').Config} */
export default [
  {
    ignores: [".next/**"],
  },
  ...baseConfig,
  ...reactConfig,
  ...nextjsConfig,
];
