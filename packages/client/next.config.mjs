/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Compile the workspace shared package from source.
  transpilePackages: ["@raffle/shared"],
  // Linting runs from the repo root (`npm run lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
