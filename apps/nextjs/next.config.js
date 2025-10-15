const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

const getRemotePatterns = () => {
  /** @type {import('next').NextConfig['remotePatterns']} */
  const remotePatterns = [];

  if (SUPABASE_URL) {
    const hostname = new URL(SUPABASE_URL).hostname;

    remotePatterns.push({
      protocol: "https",
      hostname,
    });
  }

  if (!IS_PRODUCTION) {
    remotePatterns.push({
      protocol: "http",
      hostname: "127.0.0.1",
    });

    remotePatterns.push({
      protocol: "http",
      hostname: "localhost",
    });
  }

  return remotePatterns;
};

const transpilePackages = [
  "@repo/api",
  "@repo/db",
  "@repo/ui",
  "@repo/multiplayer",
];

/** @type {import("next").NextConfig} */
const config = {
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  transpilePackages,
  images: {
    remotePatterns: getRemotePatterns(),
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.md/,
      type: "asset/source",
    });
    return config;
  },
  turbopack: {
    rules: {
      "*.md": {
        loaders: ["raw-loader"],
        as: "*.js",
      },
    },
  },
  /** We already do linting and typechecking as separate tasks in CI */
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default config;
